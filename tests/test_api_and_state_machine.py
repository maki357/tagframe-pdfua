import concurrent.futures
import hashlib
import hmac
import json
import os
import sys
import unittest
from pathlib import Path

API_DIR = Path(__file__).resolve().parent.parent / "apps" / "api"
sys.path.insert(0, str(API_DIR))

from fastapi.testclient import TestClient  # noqa: E402
import server  # noqa: E402
from db import TagFrameStore, compute_discounted_price_cents, validate_currency_and_cents  # noqa: E402


class TestTagFrameApiAndStateMachine(unittest.TestCase):
    def setUp(self):
        # Fresh hermetic in-memory store per test
        server.store = TagFrameStore(database_url="")
        os.environ["ADMIN_TOKEN"] = "test-admin-secret"
        os.environ["PADDLE_WEBHOOK_SECRET"] = "test-paddle-secret"
        self.client = TestClient(server.app)

    def _signed_headers(self, body_bytes: bytes, ts: str = "1763850000") -> dict[str, str]:
        sig = hmac.new(
            os.environ["PADDLE_WEBHOOK_SECRET"].encode("utf-8"),
            f"{ts}:".encode("utf-8") + body_bytes,
            hashlib.sha256,
        ).hexdigest()
        return {"Paddle-Signature": f"ts={ts};h1={sig}", "Content-Type": "application/json"}

    def test_1_webhook_idempotency_and_self_echo(self):
        payload = {
            "event_id": "evt_001",
            "event_type": "subscription.activated",
            "occurred_at": "2026-11-22T10:00:00Z",
            "data": {
                "id": "sub_100",
                "status": "active",
                "currency_code": "USD",
                "amount_cents": 14900,
                "customer_email": "agency@example.eu",
                "custom_data": {"plan_tier": "pro"},
            },
        }
        raw = json.dumps(payload).encode("utf-8")
        # Bad signature must fail 401
        bad = self.client.post("/api/paddle/webhook", content=raw, headers={"Paddle-Signature": "ts=1;h1=bad"})
        self.assertEqual(bad.status_code, 401)

        # First valid delivery applies
        r1 = self.client.post("/api/paddle/webhook", content=raw, headers=self._signed_headers(raw))
        self.assertEqual(r1.status_code, 200)
        self.assertEqual(r1.json()["action"], "APPLIED")

        # Duplicate event_id -> idempotent no-op
        r2 = self.client.post("/api/paddle/webhook", content=raw, headers=self._signed_headers(raw))
        self.assertEqual(r2.status_code, 200)
        self.assertEqual(r2.json()["action"], "IGNORED_DUPLICATE_EVENT")

        # New event_id with identical state -> self-echo ignored
        payload["event_id"] = "evt_002"
        payload["occurred_at"] = "2026-11-22T10:05:00Z"
        raw2 = json.dumps(payload).encode("utf-8")
        r3 = self.client.post("/api/paddle/webhook", content=raw2, headers=self._signed_headers(raw2))
        self.assertEqual(r3.status_code, 200)
        self.assertEqual(r3.json()["action"], "IGNORED_SELF_ECHO")

    def test_2_out_of_order_webhook_cannot_reactivate_canceled_license(self):
        cancel_evt = {
            "event_id": "evt_cancel",
            "event_type": "subscription.canceled",
            "occurred_at": "2026-11-22T12:00:00Z",
            "data": {"id": "sub_200", "status": "canceled", "currency_code": "EUR", "amount_cents": 14900, "custom_data": {"plan_tier": "pro"}},
        }
        raw_c = json.dumps(cancel_evt).encode("utf-8")
        rc = self.client.post("/api/paddle/webhook", content=raw_c, headers=self._signed_headers(raw_c))
        self.assertEqual(rc.json()["action"], "APPLIED")
        lic_key = rc.json()["license_key"]

        # Delayed older activation arrives AFTER cancellation
        late_evt = {
            "event_id": "evt_late_activate",
            "event_type": "subscription.activated",
            "occurred_at": "2026-11-22T11:30:00Z",
            "data": {"id": "sub_200", "status": "active", "currency_code": "EUR", "amount_cents": 14900, "custom_data": {"plan_tier": "pro"}},
        }
        raw_l = json.dumps(late_evt).encode("utf-8")
        rl = self.client.post("/api/paddle/webhook", content=raw_l, headers=self._signed_headers(raw_l))
        self.assertEqual(rl.status_code, 200)
        self.assertEqual(rl.json()["action"], "IGNORED_OUT_OF_ORDER")

        # Verify license remains canceled
        v = self.client.get(f"/api/license/verify?key={lic_key}").json()
        self.assertFalse(v["valid"])
        self.assertEqual(v["status"], "canceled")

    def test_3_concurrent_quota_enforcement_exact_limit(self):
        # Create a 3-page free tier license
        res = server.store.apply_paddle_webhook(
            event_id="evt_free",
            event_type="subscription.created",
            subscription_id="sub_free",
            occurred_at_utc="2026-11-22T09:00:00Z",
            customer_email="free@example.eu",
            plan_tier="free",
            status="active",
            currency="USD",
            amount_cents=0,
            license_key="TF-FREE-TEST",
        )
        self.assertEqual(res["action"], "APPLIED")

        # Fire 6 concurrent 1-page consumption requests -> EXACTLY 3 must succeed
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            futs = [pool.submit(server.store.consume_pages_atomic, "TF-FREE-TEST", 1) for _ in range(6)]
            outcomes = [f.result() for f in futs]

        allowed = [o for o in outcomes if o["allowed"]]
        denied = [o for o in outcomes if not o["allowed"]]
        self.assertEqual(len(allowed), 3)
        self.assertEqual(len(denied), 3)
        self.assertTrue(all(d["reason"] == "QUOTA_EXCEEDED" for d in denied))

    def test_4_boundary_discount_and_iso4217_money_invariants(self):
        # 100% discount -> 0 cents with warning
        r100 = compute_discounted_price_cents(14900, discount_percent=100)
        self.assertEqual(r100["final_price_cents"], 0)
        self.assertIn("100%_DISCOUNT_FLOOR_ZERO", r100["warnings"])

        # Fixed discount > price -> clamped safely to 0 (never negative)
        rover = compute_discounted_price_cents(14900, discount_fixed_cents=25000)
        self.assertEqual(rover["final_price_cents"], 0)
        self.assertIn("DISCOUNT_EXCEEDS_PRICE_CLAMPED_TO_ZERO", rover["warnings"])

        # Float money rejected
        with self.assertRaises(ValueError):
            validate_currency_and_cents("USD", 149.00)  # type: ignore[arg-type]

        # Zero-decimal currencies JPY/KRW explicitly rejected in MVP
        with self.assertRaises(ValueError):
            validate_currency_and_cents("JPY", 15000)
        with self.assertRaises(ValueError):
            validate_currency_and_cents("KRW", 200000)

    def test_5_leads_stateless_in_memory_csv_and_auth(self):
        r = self.client.post(
            "/api/leads",
            json={"email": "lead@agency.de", "team_type": "Design Agency", "intent": "sample_test", "figma_url": "https://figma.com/file/abc", "notes": "EAA annual report"},
        )
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()["ok"])

        # Unauthorized export rejected
        unauth = self.client.get("/api/admin/leads.csv")
        self.assertEqual(unauth.status_code, 401)

        # Authorized in-memory CSV returns row
        csv_resp = self.client.get("/api/admin/leads.csv", headers={"Authorization": "Bearer test-admin-secret"})
        self.assertEqual(csv_resp.status_code, 200)
        self.assertIn("lead@agency.de", csv_resp.text)
        self.assertIn("EAA annual report", csv_resp.text)

    def test_6_compile_endpoint_valid_hidden_and_missing_alt_guards(self):
        # Missing Alt on Figure must return 422
        bad_fig = {
            "title": "Bad Figure Deck",
            "lang": "en-US",
            "frames": [{"id": "f1", "width": 960, "height": 540, "nodes": [{"id": "fig1", "role": "Figure", "alt": "", "readingOrder": 0}]}],
        }
        r_bad = self.client.post("/api/compile", json=bad_fig)
        self.assertEqual(r_bad.status_code, 422)

        # Valid scene with hidden node skipped + empty frame resilience
        good_scene = {
            "title": "EAA Test Export",
            "lang": "en-US",
            "frames": [
                {
                    "id": "f1",
                    "width": 960,
                    "height": 540,
                    "nodes": [
                        {"id": "n1", "role": "H1", "text": "Accessible Title", "fontSize": 28, "readingOrder": 0},
                        {"id": "n_hidden", "role": "P", "text": "Should be skipped", "visible": False, "readingOrder": 1},
                        {"id": "n2", "role": "P", "text": "Body paragraph with live text.", "fontSize": 14, "readingOrder": 2},
                    ],
                },
                {"id": "f_empty", "width": 960, "height": 540, "nodes": []},
            ],
        }
        r_ok = self.client.post("/api/compile", json=good_scene)
        self.assertEqual(r_ok.status_code, 200)
        self.assertEqual(r_ok.headers["content-type"], "application/pdf")
        self.assertEqual(r_ok.headers["x-tagframe-standard"], "ISO-14289-1-UA1")
        self.assertTrue(r_ok.content.startswith(b"%PDF-"))


if __name__ == "__main__":
    unittest.main(verbosity=2)

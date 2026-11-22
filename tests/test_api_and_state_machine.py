import base64
import concurrent.futures
import glob
import hashlib
import hmac
import json
import os
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib
from pathlib import Path

API_DIR = Path(__file__).resolve().parent.parent / "apps" / "api"
sys.path.insert(0, str(API_DIR))

from fastapi.testclient import TestClient  # noqa: E402
import server  # noqa: E402
from compiler import compile_figma_scene_to_pdfua1  # noqa: E402
from db import TagFrameStore, compute_discounted_price_cents, validate_currency_and_cents  # noqa: E402


def _make_valid_png_bytes(width: int = 4, height: int = 4, rgb: tuple[int, int, int] = (240, 248, 255)) -> bytes:
    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + bytes(rgb) * width for _ in range(height))
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )


def _find_sample_system_ttf() -> bytes:
    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
        r"C:\Windows\Fonts\georgia.ttf",
        r"C:\Windows\Fonts\arial.ttf",
    ]
    for cand in candidates:
        if os.path.isfile(cand) and os.path.getsize(cand) <= 4 * 1024 * 1024:
            with open(cand, "rb") as f:
                data = f.read()
            if data[:4] in (b"\x00\x01\x00\x00", b"OTTO", b"true"):
                return data
    # Minimal valid sfnt header fallback (Typst gracefully falls back if glyphs absent)
    return b"\x00\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00"


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
        self.assertEqual(r_ok.headers["x-tagframe-layout-mode"], "flow")
        self.assertTrue(r_ok.content.startswith(b"%PDF-"))

    def test_7_positioned_mode_multicolumn_reading_order_and_bg_artifact(self):
        bg_png_b64 = "data:image/png;base64," + base64.b64encode(_make_valid_png_bytes(8, 8, (248, 250, 252))).decode("ascii")
        fig_png_b64 = base64.b64encode(_make_valid_png_bytes(6, 6, (15, 118, 110))).decode("ascii")

        # Invalid layoutMode -> 422
        r_bad_mode = self.client.post(
            "/api/compile",
            json={"title": "Bad Mode", "layoutMode": "absolute-invalid", "frames": [{"id": "f1", "nodes": []}]},
        )
        self.assertEqual(r_bad_mode.status_code, 422)

        # Invalid backgroundImageBase64 magic bytes -> 422
        r_bad_bg = self.client.post(
            "/api/compile",
            json={
                "title": "Bad BG",
                "layoutMode": "positioned",
                "frames": [
                    {
                        "id": "f1",
                        "width": 960,
                        "height": 540,
                        "backgroundImageBase64": base64.b64encode(b"NOT_A_PNG_OR_JPEG").decode("ascii"),
                        "nodes": [],
                    }
                ],
            },
        )
        self.assertEqual(r_bad_bg.status_code, 422)

        # Oversized backgroundImageBase64 (> 10 MB) -> 422
        oversized_png_b64 = base64.b64encode(b"\x89PNG\r\n\x1a\n" + (b"\x00" * (10 * 1024 * 1024 + 32))).decode("ascii")
        r_big_bg = self.client.post(
            "/api/compile",
            json={
                "title": "Oversized BG",
                "layoutMode": "positioned",
                "frames": [{"id": "f1", "width": 960, "height": 540, "backgroundImageBase64": oversized_png_b64, "nodes": []}],
            },
        )
        self.assertEqual(r_big_bg.status_code, 422)

        # Valid 2-column positioned scene where readingOrder intentionally differs from visual (x, y) order
        positioned_scene = {
            "title": "Multi-Column Positioned EAA Deck",
            "author": "TagFrame QA",
            "lang": "en-US",
            "layoutMode": "positioned",
            "frames": [
                {
                    "id": "slide-1",
                    "name": "Two Column Executive Slide",
                    "width": 960,
                    "height": 540,
                    "backgroundColor": "#FFFFFF",
                    "backgroundImageBase64": bg_png_b64,
                    "nodes": [
                        # Visually LOWER and RIGHT, but readingOrder=0 -> MUST appear first in /StructTreeRoot (H1 before H2)
                        {
                            "id": "col-right-h1",
                            "role": "H1",
                            "text": "Right Column Primary Title (Read First)",
                            "x": 500,
                            "y": 300,
                            "width": 410,
                            "height": 48,
                            "fontSize": 26,
                            "fontWeight": "Bold",
                            "color": "#0F172A",
                            "readingOrder": 0,
                        },
                        # Visually HIGHER and LEFT, but readingOrder=1 -> MUST appear second (H2 after H1)
                        {
                            "id": "col-left-h2",
                            "role": "H2",
                            "text": "Left Column Subtitle (Read Second)",
                            "x": 40,
                            "y": 36,
                            "width": 400,
                            "height": 34,
                            "fontSize": 20,
                            "fontWeight": "Bold",
                            "color": "#1E293B",
                            "readingOrder": 1,
                        },
                        # width=0 tests safe default width fallback + multi-paragraph splitting
                        {
                            "id": "col-left-body",
                            "role": "P",
                            "text": "First paragraph in left column.\n\nSecond paragraph without parbreak warning.",
                            "x": 40,
                            "y": 90,
                            "width": 0,
                            "fontSize": 13,
                            "color": "#334155",
                            "readingOrder": 2,
                        },
                        # Figure with embedded PNG + Alt text in right top quadrant
                        {
                            "id": "col-right-fig",
                            "role": "Figure",
                            "alt": "Revenue trajectory chart showing Q1 to Q4 growth.",
                            "imageBase64": fig_png_b64,
                            "x": 500,
                            "y": 40,
                            "width": 380,
                            "height": 140,
                            "readingOrder": 3,
                        },
                        # Data table with headers
                        {
                            "id": "col-left-tbl",
                            "role": "Table",
                            "headers": ["Region", "Compliance"],
                            "rows": [["EU", "ISO 14289-1"], ["DE", "BFSG Ready"]],
                            "x": 40,
                            "y": 230,
                            "width": 400,
                            "readingOrder": 4,
                        },
                        # List + Link + decorative Artifact + out-of-bounds coordinate clamping check
                        {
                            "id": "col-left-list",
                            "role": "List",
                            "items": ["Tagged /StructTreeRoot", "Deterministic Reading Order"],
                            "x": 40,
                            "y": 370,
                            "width": 380,
                            "readingOrder": 5,
                        },
                        {
                            "id": "col-left-link",
                            "role": "Link",
                            "text": "Accessibility Statement",
                            "url": "https://example.eu/accessibility",
                            "x": -25,  # clamped safely to 0pt
                            "y": 470,
                            "width": 260,
                            "readingOrder": 6,
                        },
                        {
                            "id": "deco-bar",
                            "role": "Artifact",
                            "x": 0,
                            "y": 0,
                            "width": 9999,  # clamped safely inside 960pt
                            "height": 8,
                            "color": "#0F766E",
                            "readingOrder": 7,
                        },
                    ],
                },
                {
                    "id": "slide-2",
                    "name": "Second Positioned Slide",
                    "width": 960,
                    "height": 540,
                    "backgroundColor": "#F8FAFC",
                    "nodes": [
                        {
                            "id": "s2-h2",
                            "role": "H2",
                            "text": "Appendix Details",
                            "x": 48,
                            "y": 48,
                            "width": 500,
                            "fontSize": 22,
                            "fontWeight": "Bold",
                            "readingOrder": 0,
                        }
                    ],
                },
            ],
        }

        r_pos = self.client.post("/api/compile", json=positioned_scene)
        self.assertEqual(r_pos.status_code, 200, r_pos.text)
        self.assertEqual(r_pos.headers["x-tagframe-standard"], "ISO-14289-1-UA1")
        self.assertEqual(r_pos.headers["x-tagframe-layout-mode"], "positioned")
        self.assertTrue(r_pos.content.startswith(b"%PDF-"))

        # Verify directly via compiler telemetry & pdfua_inspector.js (deterministic reading order H1 -> H2 -> H2)
        pdf_bytes, tel = compile_figma_scene_to_pdfua1(positioned_scene)
        self.assertEqual(tel["layout_mode"], "positioned")
        self.assertEqual(tel["frames_compiled"], 2)
        self.assertEqual(tel["nodes_compiled"], 9)

        inspector_path = Path(__file__).resolve().parent.parent / "apps" / "web" / "pdfua_inspector.js"
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tf:
            tf.write(pdf_bytes)
            tmp_pdf = tf.name
        try:
            node_script = (
                f'import fs from "node:fs"; '
                f'import {{ inspectPdfUa }} from {json.dumps(inspector_path.as_uri())}; '
                f'const r = await inspectPdfUa(fs.readFileSync(process.argv[1]), "positioned.pdf"); '
                f'console.log(JSON.stringify(r));'
            )
            proc = subprocess.run(["node", "-e", node_script, tmp_pdf], capture_output=True, text=True, check=True)
            report = json.loads(proc.stdout)
            self.assertTrue(report["ok"])
            self.assertEqual(report["verdict"], "PASS", f"Non-PASS checks: {[c for c in report['checks'] if c['status'] != 'PASS']}")
            self.assertEqual(report["summary"]["fail"], 0)
            self.assertEqual(report["pageCount"], 2)
            # H1 (y=300, readingOrder=0) MUST precede H2 (y=36, readingOrder=1) in /StructTreeRoot!
            self.assertEqual(report["metrics"]["headingsSequence"], ["H1", "H2", "H2"])
            self.assertEqual(report["metrics"]["tableCount"], 1)
            self.assertEqual(report["metrics"]["tablesWithTh"], 1)
            self.assertEqual(len(report["metrics"]["figures"]), 1)
            self.assertTrue(report["metrics"]["figures"][0]["hasAlt"])
        finally:
            os.unlink(tmp_pdf)

    def test_8_custom_fonts_traversal_rejection_limits_and_valid_ephemeral_loading(self):
        sample_ttf = _find_sample_system_ttf()
        sample_ttf_b64 = base64.b64encode(sample_ttf).decode("ascii")

        base_frames = [
            {
                "id": "f1",
                "width": 960,
                "height": 540,
                "nodes": [
                    {
                        "id": "h1",
                        "role": "H1",
                        "text": "Custom Font Brand Deck",
                        "x": 40,
                        "y": 40,
                        "width": 500,
                        "fontSize": 28,
                        "fontWeight": "Bold",
                        "fontFamily": "Brand Sans",
                        "readingOrder": 0,
                    },
                    {
                        "id": "p1",
                        "role": "P",
                        "text": "Injection fontFamily is safely ignored.",
                        "x": 40,
                        "y": 100,
                        "width": 500,
                        "fontFamily": 'Arial"), #panic("pwn")',
                        "readingOrder": 1,
                    },
                ],
            }
        ]

        # Path traversal & bad extension payloads MUST raise ValueError & HTTP 422
        for bad_name in [
            "../evil.ttf",
            "..\\evil.otf",
            "nested/dir.ttf",
            ".hidden.ttf",
            "weird..dots.ttf",
            "malware.exe",
            "payload.typ",
            "has spaces.ttf",
        ]:
            bad_scene = {
                "title": "Traversal Test",
                "layoutMode": "positioned",
                "customFonts": [{"filename": bad_name, "base64": sample_ttf_b64}],
                "frames": base_frames,
            }
            with self.assertRaises(ValueError, msg=f"Expected ValueError for {bad_name}"):
                compile_figma_scene_to_pdfua1(bad_scene)
            resp = self.client.post("/api/compile", json=bad_scene)
            self.assertEqual(resp.status_code, 422, f"Expected 422 for {bad_name}, got {resp.status_code}")

        # Non-font binary masquerading as .ttf -> 422
        r_fake_bin = self.client.post(
            "/api/compile",
            json={
                "title": "Fake Font",
                "customFonts": [{"filename": "Fake.ttf", "base64": base64.b64encode(b"<html>not a font</html>").decode("ascii")}],
                "frames": base_frames,
            },
        )
        self.assertEqual(r_fake_bin.status_code, 422)

        # More than 5 custom fonts -> 422
        r_too_many = self.client.post(
            "/api/compile",
            json={
                "title": "Too Many Fonts",
                "customFonts": [{"filename": f"Font{i}.ttf", "base64": sample_ttf_b64} for i in range(6)],
                "frames": base_frames,
            },
        )
        self.assertEqual(r_too_many.status_code, 422)

        # Single font > 5 MB -> 422
        big_font_b64 = base64.b64encode(b"\x00\x01\x00\x00" + (b"\x00" * (5 * 1024 * 1024 + 16))).decode("ascii")
        r_big_font = self.client.post(
            "/api/compile",
            json={
                "title": "Oversized Font",
                "customFonts": [{"filename": "Huge.ttf", "base64": big_font_b64}],
                "frames": base_frames,
            },
        )
        self.assertEqual(r_big_font.status_code, 422)

        # Oversized raw HTTP body guard -> 422
        orig_limit = server.MAX_COMPILE_BODY_BYTES
        server.MAX_COMPILE_BODY_BYTES = 128
        try:
            r_big_body = self.client.post("/api/compile", json={"title": "Body Cap", "frames": base_frames})
            self.assertEqual(r_big_body.status_code, 422)
        finally:
            server.MAX_COMPILE_BODY_BYTES = orig_limit

        # Valid custom font path handling + verify ephemeral tmpdir cleanup
        before_tmpdirs = set(glob.glob(os.path.join(tempfile.gettempdir(), "tagframe_mem_*")))
        valid_font_scene = {
            "title": "Valid Custom Font Export",
            "layoutMode": "positioned",
            "customFonts": [{"filename": "BrandCustom-Regular.ttf", "base64": sample_ttf_b64}],
            "frames": base_frames,
        }
        pdf_bytes, tel = compile_figma_scene_to_pdfua1(valid_font_scene)
        self.assertTrue(pdf_bytes.startswith(b"%PDF-"))
        self.assertGreaterEqual(len(tel["custom_fonts_loaded"]), 1)

        r_ok = self.client.post("/api/compile", json=valid_font_scene)
        self.assertEqual(r_ok.status_code, 200, r_ok.text)
        self.assertTrue(r_ok.content.startswith(b"%PDF-"))

        after_tmpdirs = set(glob.glob(os.path.join(tempfile.gettempdir(), "tagframe_mem_*")))
        self.assertEqual(after_tmpdirs - before_tmpdirs, set(), "Ephemeral font/compile tmpdir leaked on disk!")


if __name__ == "__main__":
    unittest.main(verbosity=2)

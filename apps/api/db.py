"""
Stateless Database Repository for TagFrame PDF/UA.
- Production (Railway): Uses PostgreSQL via DATABASE_URL (psycopg v3) with BIGINT cents and UTC ISO-8601.
- Local/Tests: Uses in-memory SQLite (`:memory:`) with identical schema & transactional semantics.
Zero CSV or report files are ever written to local server disk.
"""
from __future__ import annotations

import csv
import io
import os
import sqlite3
import threading
from datetime import datetime, timezone
from typing import Any, Optional

SUPPORTED_ISO4217_CENTS = {
    "USD": 2,
    "EUR": 2,
    "GBP": 2,
    "CAD": 2,
    "AUD": 2,
    "CHF": 2,
    "RSD": 2,
}
ZERO_DECIMAL_CURRENCIES = {"JPY", "KRW", "VND", "CLP", "ISK"}


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def validate_currency_and_cents(currency: str, amount_cents: int) -> tuple[str, int]:
    """Enforce integer-only money (no FLOAT/REAL) and explicit ISO-4217 validation."""
    if not isinstance(amount_cents, int) or isinstance(amount_cents, bool):
        raise ValueError("Money amount must be an integer in smallest currency unit (no float/real).")
    code = (currency or "").strip().upper()
    if code in ZERO_DECIMAL_CURRENCIES:
        raise ValueError(f"Zero-decimal currency '{code}' is explicitly rejected in MVP (ISO-4217 guard).")
    if code not in SUPPORTED_ISO4217_CENTS:
        raise ValueError(f"Unsupported ISO-4217 currency '{code}'.")
    return code, amount_cents


def compute_discounted_price_cents(base_price_cents: int, discount_percent: int = 0, discount_fixed_cents: int = 0) -> dict[str, Any]:
    """
    Deterministic integer-only discount math with boundary protection:
    - 100% discount or discount > price NEVER produces negative prices.
    - Clamps safely to 0 cents (free) or flags explicit Dry-Run warning on extreme deviations.
    """
    if not all(isinstance(v, int) and not isinstance(v, bool) for v in (base_price_cents, discount_percent, discount_fixed_cents)):
        raise ValueError("All pricing inputs must be exact integers.")
    if base_price_cents < 0 or discount_percent < 0 or discount_fixed_cents < 0:
        raise ValueError("Negative pricing inputs are invalid.")

    warnings: list[str] = []
    pct_clamped = min(discount_percent, 100)
    if discount_percent >= 100:
        warnings.append("100%_DISCOUNT_FLOOR_ZERO")

    # Integer half-up division for percent off
    pct_off_cents = (base_price_cents * pct_clamped + 50) // 100
    after_pct = base_price_cents - pct_off_cents
    raw_final = after_pct - discount_fixed_cents

    if raw_final < 0:
        warnings.append("DISCOUNT_EXCEEDS_PRICE_CLAMPED_TO_ZERO")
        final_cents = 0
    elif raw_final == 0 and base_price_cents > 0 and "100%_DISCOUNT_FLOOR_ZERO" not in warnings:
        warnings.append("FINAL_PRICE_ZERO")
        final_cents = 0
    else:
        final_cents = raw_final

    return {
        "base_price_cents": base_price_cents,
        "final_price_cents": final_cents,
        "warnings": warnings,
    }


class TagFrameStore:
    def __init__(self, database_url: Optional[str] = None):
        self.database_url = (database_url or os.environ.get("DATABASE_URL") or "").strip()
        self.is_postgres = self.database_url.startswith("postgres://") or self.database_url.startswith("postgresql://")
        self._lock = threading.Lock()
        self._sqlite_conn: Optional[sqlite3.Connection] = None

        if not self.is_postgres:
            # Strict in-memory SQLite when no Postgres DATABASE_URL is provided (zero local disk files)
            self._sqlite_conn = sqlite3.connect(":memory:", check_same_thread=False)
            self._sqlite_conn.row_factory = sqlite3.Row
        self._init_schema()

    def _pg_connect(self):
        import psycopg
        from psycopg.rows import dict_row
        return psycopg.connect(self.database_url, row_factory=dict_row)

    def _init_schema(self) -> None:
        ddl_statements = [
            """
            CREATE TABLE IF NOT EXISTS leads (
                id TEXT PRIMARY KEY,
                email TEXT NOT NULL,
                team_type TEXT NOT NULL,
                intent TEXT NOT NULL,
                figma_url TEXT NOT NULL,
                notes TEXT NOT NULL,
                created_at_utc TEXT NOT NULL
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS licenses (
                license_key TEXT PRIMARY KEY,
                subscription_id TEXT UNIQUE NOT NULL,
                customer_email TEXT NOT NULL,
                plan_tier TEXT NOT NULL,
                status TEXT NOT NULL,
                currency TEXT NOT NULL,
                amount_cents BIGINT NOT NULL,
                seat_limit INTEGER NOT NULL,
                seats_used INTEGER NOT NULL DEFAULT 0,
                monthly_page_limit INTEGER NOT NULL,
                pages_used_this_month INTEGER NOT NULL DEFAULT 0,
                quota_period_utc TEXT NOT NULL,
                last_event_at_utc TEXT NOT NULL,
                last_applied_state TEXT NOT NULL,
                updated_at_utc TEXT NOT NULL
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS webhook_events (
                event_id TEXT PRIMARY KEY,
                event_type TEXT NOT NULL,
                subscription_id TEXT NOT NULL,
                occurred_at_utc TEXT NOT NULL,
                processed_at_utc TEXT NOT NULL
            )
            """,
        ]
        if self.is_postgres:
            with self._pg_connect() as conn:
                with conn.cursor() as cur:
                    for stmt in ddl_statements:
                        cur.execute(stmt)
                conn.commit()
        else:
            with self._lock:
                cur = self._sqlite_conn.cursor()
                for stmt in ddl_statements:
                    cur.execute(stmt)
                self._sqlite_conn.commit()

    def insert_lead(self, lead_id: str, email: str, team_type: str, intent: str, figma_url: str, notes: str) -> dict[str, Any]:
        now = utc_now_iso()
        record = {
            "id": lead_id,
            "email": email.strip(),
            "team_type": team_type.strip() or "Unspecified",
            "intent": intent.strip() or "sample_test",
            "figma_url": figma_url.strip(),
            "notes": notes.strip()[:2000],
            "created_at_utc": now,
        }
        if self.is_postgres:
            with self._pg_connect() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        INSERT INTO leads (id, email, team_type, intent, figma_url, notes, created_at_utc)
                        VALUES (%s, %s, %s, %s, %s, %s, %s)
                        """,
                        (record["id"], record["email"], record["team_type"], record["intent"], record["figma_url"], record["notes"], record["created_at_utc"]),
                    )
                conn.commit()
        else:
            with self._lock:
                self._sqlite_conn.execute(
                    """
                    INSERT INTO leads (id, email, team_type, intent, figma_url, notes, created_at_utc)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (record["id"], record["email"], record["team_type"], record["intent"], record["figma_url"], record["notes"], record["created_at_utc"]),
                )
                self._sqlite_conn.commit()
        return record

    def export_leads_csv_in_memory(self) -> str:
        """Generate leads CSV purely in RAM on demand (zero disk writes)."""
        if self.is_postgres:
            with self._pg_connect() as conn:
                with conn.cursor() as cur:
                    cur.execute("SELECT id, email, team_type, intent, figma_url, notes, created_at_utc FROM leads ORDER BY created_at_utc DESC")
                    rows = cur.fetchall()
        else:
            with self._lock:
                cur = self._sqlite_conn.execute("SELECT id, email, team_type, intent, figma_url, notes, created_at_utc FROM leads ORDER BY created_at_utc DESC")
                rows = [dict(r) for r in cur.fetchall()]

        buf = io.StringIO()
        writer = csv.DictWriter(buf, fieldnames=["id", "email", "team_type", "intent", "figma_url", "notes", "created_at_utc"])
        writer.writeheader()
        for row in rows:
            writer.writerow(row)
        return buf.getvalue()

    def apply_paddle_webhook(
        self,
        event_id: str,
        event_type: str,
        subscription_id: str,
        occurred_at_utc: str,
        customer_email: str,
        plan_tier: str,
        status: str,
        currency: str,
        amount_cents: int,
        license_key: str,
    ) -> dict[str, Any]:
        """
        Transactional Paddle webhook state machine:
        1. Validates integer BIGINT cents + ISO-4217 currency (rejects float & zero-decimal JPY/KRW).
        2. Idempotent by event_id (duplicate webhook_id -> no-op).
        3. Out-of-order guard: ignores events where occurred_at_utc <= last_event_at_utc.
        4. Self-echo guard: ignores events where incoming state == last_applied_state.
        """
        currency_code, valid_cents = validate_currency_and_cents(currency, amount_cents)
        if valid_cents < 0:
            raise ValueError("amount_cents cannot be negative.")

        seat_limit = 5 if plan_tier == "agency" else 1
        page_limit = 999999 if status == "active" and plan_tier in ("pro", "agency", "founding") else 3
        state_sig = f"{status}|{plan_tier}|{currency_code}|{valid_cents}|{seat_limit}"
        now = utc_now_iso()
        period = now[:7]  # YYYY-MM UTC

        if self.is_postgres:
            with self._pg_connect() as conn:
                with conn.cursor() as cur:
                    cur.execute("SELECT event_id FROM webhook_events WHERE event_id = %s", (event_id,))
                    if cur.fetchone():
                        return {"action": "IGNORED_DUPLICATE_EVENT", "event_id": event_id}

                    cur.execute("SELECT * FROM licenses WHERE subscription_id = %s FOR UPDATE", (subscription_id,))
                    existing = cur.fetchone()
                    if existing:
                        if occurred_at_utc <= existing["last_event_at_utc"]:
                            cur.execute(
                                "INSERT INTO webhook_events (event_id, event_type, subscription_id, occurred_at_utc, processed_at_utc) VALUES (%s,%s,%s,%s,%s)",
                                (event_id, event_type, subscription_id, occurred_at_utc, now),
                            )
                            conn.commit()
                            return {"action": "IGNORED_OUT_OF_ORDER", "event_id": event_id}
                        if state_sig == existing["last_applied_state"]:
                            cur.execute(
                                "INSERT INTO webhook_events (event_id, event_type, subscription_id, occurred_at_utc, processed_at_utc) VALUES (%s,%s,%s,%s,%s)",
                                (event_id, event_type, subscription_id, occurred_at_utc, now),
                            )
                            conn.commit()
                            return {"action": "IGNORED_SELF_ECHO", "event_id": event_id}
                        cur.execute(
                            """
                            UPDATE licenses
                            SET plan_tier=%s, status=%s, currency=%s, amount_cents=%s, seat_limit=%s,
                                monthly_page_limit=%s, last_event_at_utc=%s, last_applied_state=%s, updated_at_utc=%s
                            WHERE subscription_id=%s
                            """,
                            (plan_tier, status, currency_code, valid_cents, seat_limit, page_limit, occurred_at_utc, state_sig, now, subscription_id),
                        )
                        key_out = existing["license_key"]
                    else:
                        cur.execute(
                            """
                            INSERT INTO licenses (
                                license_key, subscription_id, customer_email, plan_tier, status, currency,
                                amount_cents, seat_limit, seats_used, monthly_page_limit, pages_used_this_month,
                                quota_period_utc, last_event_at_utc, last_applied_state, updated_at_utc
                            ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,0,%s,0,%s,%s,%s,%s)
                            """,
                            (license_key, subscription_id, customer_email, plan_tier, status, currency_code, valid_cents, seat_limit, page_limit, period, occurred_at_utc, state_sig, now),
                        )
                        key_out = license_key

                    cur.execute(
                        "INSERT INTO webhook_events (event_id, event_type, subscription_id, occurred_at_utc, processed_at_utc) VALUES (%s,%s,%s,%s,%s)",
                        (event_id, event_type, subscription_id, occurred_at_utc, now),
                    )
                conn.commit()
                return {"action": "APPLIED", "license_key": key_out, "status": status, "plan_tier": plan_tier}
        else:
            with self._lock:
                cur = self._sqlite_conn.cursor()
                if cur.execute("SELECT event_id FROM webhook_events WHERE event_id = ?", (event_id,)).fetchone():
                    return {"action": "IGNORED_DUPLICATE_EVENT", "event_id": event_id}

                existing = cur.execute("SELECT * FROM licenses WHERE subscription_id = ?", (subscription_id,)).fetchone()
                if existing:
                    if occurred_at_utc <= existing["last_event_at_utc"]:
                        cur.execute(
                            "INSERT INTO webhook_events (event_id, event_type, subscription_id, occurred_at_utc, processed_at_utc) VALUES (?,?,?,?,?)",
                            (event_id, event_type, subscription_id, occurred_at_utc, now),
                        )
                        self._sqlite_conn.commit()
                        return {"action": "IGNORED_OUT_OF_ORDER", "event_id": event_id}
                    if state_sig == existing["last_applied_state"]:
                        cur.execute(
                            "INSERT INTO webhook_events (event_id, event_type, subscription_id, occurred_at_utc, processed_at_utc) VALUES (?,?,?,?,?)",
                            (event_id, event_type, subscription_id, occurred_at_utc, now),
                        )
                        self._sqlite_conn.commit()
                        return {"action": "IGNORED_SELF_ECHO", "event_id": event_id}
                    cur.execute(
                        """
                        UPDATE licenses
                        SET plan_tier=?, status=?, currency=?, amount_cents=?, seat_limit=?,
                            monthly_page_limit=?, last_event_at_utc=?, last_applied_state=?, updated_at_utc=?
                        WHERE subscription_id=?
                        """,
                        (plan_tier, status, currency_code, valid_cents, seat_limit, page_limit, occurred_at_utc, state_sig, now, subscription_id),
                    )
                    key_out = existing["license_key"]
                else:
                    cur.execute(
                        """
                        INSERT INTO licenses (
                            license_key, subscription_id, customer_email, plan_tier, status, currency,
                            amount_cents, seat_limit, seats_used, monthly_page_limit, pages_used_this_month,
                            quota_period_utc, last_event_at_utc, last_applied_state, updated_at_utc
                        ) VALUES (?,?,?,?,?,?,?,?,0,?,0,?,?,?,?)
                        """,
                        (license_key, subscription_id, customer_email, plan_tier, status, currency_code, valid_cents, seat_limit, page_limit, period, occurred_at_utc, state_sig, now),
                    )
                    key_out = license_key

                cur.execute(
                    "INSERT INTO webhook_events (event_id, event_type, subscription_id, occurred_at_utc, processed_at_utc) VALUES (?,?,?,?,?)",
                    (event_id, event_type, subscription_id, occurred_at_utc, now),
                )
                self._sqlite_conn.commit()
                return {"action": "APPLIED", "license_key": key_out, "status": status, "plan_tier": plan_tier}

    def consume_pages_atomic(self, license_key: str, pages: int) -> dict[str, Any]:
        """Atomic concurrent quota guard: prevents parallel requests from exceeding monthly page limit."""
        if not isinstance(pages, int) or pages <= 0:
            raise ValueError("pages must be a positive integer.")
        now = utc_now_iso()
        period = now[:7]

        if self.is_postgres:
            with self._pg_connect() as conn:
                with conn.cursor() as cur:
                    cur.execute("SELECT * FROM licenses WHERE license_key = %s FOR UPDATE", (license_key,))
                    row = cur.fetchone()
                    if not row:
                        return {"allowed": False, "reason": "LICENSE_NOT_FOUND"}
                    if row["status"] != "active":
                        return {"allowed": False, "reason": "LICENSE_INACTIVE", "status": row["status"]}
                    used = 0 if row["quota_period_utc"] != period else row["pages_used_this_month"]
                    if used + pages > row["monthly_page_limit"]:
                        return {"allowed": False, "reason": "QUOTA_EXCEEDED", "used": used, "limit": row["monthly_page_limit"]}
                    new_used = used + pages
                    cur.execute(
                        "UPDATE licenses SET pages_used_this_month=%s, quota_period_utc=%s, updated_at_utc=%s WHERE license_key=%s",
                        (new_used, period, now, license_key),
                    )
                conn.commit()
                return {"allowed": True, "used": new_used, "limit": row["monthly_page_limit"]}
        else:
            with self._lock:
                cur = self._sqlite_conn.cursor()
                row = cur.execute("SELECT * FROM licenses WHERE license_key = ?", (license_key,)).fetchone()
                if not row:
                    return {"allowed": False, "reason": "LICENSE_NOT_FOUND"}
                if row["status"] != "active":
                    return {"allowed": False, "reason": "LICENSE_INACTIVE", "status": row["status"]}
                used = 0 if row["quota_period_utc"] != period else row["pages_used_this_month"]
                if used + pages > row["monthly_page_limit"]:
                    return {"allowed": False, "reason": "QUOTA_EXCEEDED", "used": used, "limit": row["monthly_page_limit"]}
                new_used = used + pages
                cur.execute(
                    "UPDATE licenses SET pages_used_this_month=?, quota_period_utc=?, updated_at_utc=? WHERE license_key=?",
                    (new_used, period, now, license_key),
                )
                self._sqlite_conn.commit()
                return {"allowed": True, "used": new_used, "limit": row["monthly_page_limit"]}

    def get_license(self, license_key: str) -> Optional[dict[str, Any]]:
        if self.is_postgres:
            with self._pg_connect() as conn:
                with conn.cursor() as cur:
                    cur.execute("SELECT * FROM licenses WHERE license_key = %s", (license_key,))
                    row = cur.fetchone()
                    return dict(row) if row else None
        else:
            with self._lock:
                row = self._sqlite_conn.execute("SELECT * FROM licenses WHERE license_key = ?", (license_key,)).fetchone()
                return dict(row) if row else None

"""
TagFrame PDF/UA — Stateless FastAPI Server (Web Checker + PDF/UA-1 Compiler + Paddle Webhook + Async Leads).
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, Header, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
import typst

from compiler import compile_figma_scene_to_pdfua1, validate_scene_inputs
from db import TagFrameStore, compute_discounted_price_cents, utc_now_iso

BASE_DIR = Path(__file__).resolve().parent.parent
WEB_DIR = BASE_DIR / "web"
MAX_COMPILE_BODY_BYTES = 45 * 1024 * 1024  # 45 MB hard raw JSON body cap (accommodates up to 5x5MB fonts + 10MB images in base64)

app = FastAPI(title="TagFrame PDF/UA API", version="0.2.0")

# Allow Figma plugin iframe (`null` origin) and browser clients cleanly
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
    expose_headers=["X-TagFrame-Standard", "X-TagFrame-Layout-Mode", "X-TagFrame-Compile-Ms", "X-TagFrame-Nodes"],
)

store = TagFrameStore()


class LeadSubmission(BaseModel):
    email: str = Field(..., min_length=5, max_length=200)
    team_type: str = Field(default="Agency", max_length=80)
    intent: str = Field(default="sample_test", max_length=40)
    figma_url: str = Field(default="", max_length=500)
    notes: str = Field(default="", max_length=2000)


class PricingPreviewRequest(BaseModel):
    base_price_cents: int
    discount_percent: int = 0
    discount_fixed_cents: int = 0


def verify_paddle_signature(raw_body: bytes, sig_header: Optional[str], secret: str) -> bool:
    """Verify Paddle-Signature header (`ts=...;h1=...`) using HMAC-SHA256."""
    if not sig_header:
        return False
    parts = {}
    for seg in sig_header.split(";"):
        if "=" in seg:
            k, v = seg.split("=", 1)
            parts[k.strip()] = v.strip()
    ts = parts.get("ts")
    h1 = parts.get("h1")
    if not ts or not h1:
        return False
    signed_payload = f"{ts}:".encode("utf-8") + raw_body
    expected = hmac.new(secret.encode("utf-8"), signed_payload, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, h1)


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "service": "tagframe-pdfua",
        "typst_version": getattr(typst, "__version__", "unknown"),
        "storage": "postgresql" if store.is_postgres else "in-memory-ephemeral",
        "utc_time": utc_now_iso(),
    }


@app.post("/api/compile")
async def compile_scene(request: Request) -> Response:
    raw = await request.body()
    if len(raw) > MAX_COMPILE_BODY_BYTES:
        raise HTTPException(status_code=422, detail=f"Scene payload exceeds {MAX_COMPILE_BODY_BYTES // (1024 * 1024)} MB limit.")
    try:
        scene = json.loads(raw.decode("utf-8"))
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON payload.")

    # Pre-validate scene structure, layoutMode, and customFonts BEFORE consuming license quota
    try:
        _, frames, _ = validate_scene_inputs(scene)
    except ValueError as ve:
        raise HTTPException(status_code=422, detail=str(ve))

    # Optional license quota enforcement when X-License-Key is passed
    license_key = request.headers.get("X-License-Key")
    if license_key:
        quota = store.consume_pages_atomic(license_key, max(1, len(frames)))
        if not quota["allowed"]:
            raise HTTPException(status_code=402, detail=quota)

    try:
        pdf_bytes, telemetry = compile_figma_scene_to_pdfua1(scene)
    except ValueError as ve:
        raise HTTPException(status_code=422, detail=str(ve))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"PDF/UA-1 compilation error: {exc}")

    safe_name = "".join(c if c.isalnum() or c in "-_" else "_" for c in (str(scene.get("title") or "export")))[:60] or "export"
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{safe_name}_pdfua1.pdf"',
            "X-TagFrame-Standard": telemetry["standard"],
            "X-TagFrame-Layout-Mode": telemetry["layout_mode"],
            "X-TagFrame-Compile-Ms": str(telemetry["compile_ms"]),
            "X-TagFrame-Nodes": str(telemetry["nodes_compiled"]),
            "Cache-Control": "no-store",
        },
    )


@app.post("/api/leads")
def submit_lead(payload: LeadSubmission) -> dict[str, Any]:
    if "@" not in payload.email or "." not in payload.email.split("@")[-1]:
        raise HTTPException(status_code=422, detail="Please enter a valid work or personal email.")
    lead_id = "lead_" + secrets.token_hex(6)
    saved = store.insert_lead(
        lead_id=lead_id,
        email=payload.email,
        team_type=payload.team_type,
        intent=payload.intent,
        figma_url=payload.figma_url,
        notes=payload.notes,
    )
    return {"ok": True, "id": saved["id"], "created_at_utc": saved["created_at_utc"]}


@app.get("/api/admin/leads.csv")
def export_leads_csv(authorization: Optional[str] = Header(default=None)) -> PlainTextResponse:
    admin_token = os.environ.get("ADMIN_TOKEN", "").strip()
    if not admin_token or authorization != f"Bearer {admin_token}":
        raise HTTPException(status_code=401, detail="Unauthorized.")
    csv_text = store.export_leads_csv_in_memory()
    return PlainTextResponse(
        content=csv_text,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="tagframe_leads.csv"', "Cache-Control": "no-store"},
    )


@app.post("/api/pricing/dry-run")
def pricing_dry_run(req: PricingPreviewRequest) -> dict[str, Any]:
    try:
        return compute_discounted_price_cents(req.base_price_cents, req.discount_percent, req.discount_fixed_cents)
    except ValueError as ve:
        raise HTTPException(status_code=422, detail=str(ve))


@app.post("/api/paddle/webhook")
async def paddle_webhook(request: Request, paddle_signature: Optional[str] = Header(default=None, alias="Paddle-Signature")) -> JSONResponse:
    raw = await request.body()
    secret = os.environ.get("PADDLE_WEBHOOK_SECRET", "").strip()
    if secret and not verify_paddle_signature(raw, paddle_signature, secret):
        raise HTTPException(status_code=401, detail="Invalid Paddle-Signature.")

    try:
        evt = json.loads(raw.decode("utf-8"))
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid webhook JSON.")

    event_id = str(evt.get("event_id") or "").strip()
    event_type = str(evt.get("event_type") or "").strip()
    occurred_at = str(evt.get("occurred_at") or "").strip()
    data = evt.get("data") or {}
    sub_id = str(data.get("id") or data.get("subscription_id") or "").strip()
    if not event_id or not sub_id or not occurred_at:
        raise HTTPException(status_code=422, detail="Missing required event_id, subscription_id, or occurred_at.")

    custom = data.get("custom_data") or {}
    plan_tier = str(custom.get("plan_tier") or "pro").lower()
    customer_email = str(data.get("customer_email") or custom.get("email") or "unknown@customer")
    status = str(data.get("status") or "active").lower()
    currency = str(data.get("currency_code") or "USD").upper()
    amount_raw = data.get("amount_cents")
    if amount_raw is None:
        amount_raw = 14900

    generated_key = "TF-" + secrets.token_hex(8).upper()
    try:
        result = store.apply_paddle_webhook(
            event_id=event_id,
            event_type=event_type,
            subscription_id=sub_id,
            occurred_at_utc=occurred_at,
            customer_email=customer_email,
            plan_tier=plan_tier,
            status=status,
            currency=currency,
            amount_cents=amount_raw,
            license_key=generated_key,
        )
    except ValueError as ve:
        raise HTTPException(status_code=422, detail=str(ve))

    return JSONResponse(status_code=200, content=result)


@app.get("/api/license/verify")
def verify_license(key: str) -> dict[str, Any]:
    lic = store.get_license(key.strip())
    if not lic:
        return {"valid": False, "reason": "NOT_FOUND"}
    return {
        "valid": lic["status"] == "active",
        "plan_tier": lic["plan_tier"],
        "status": lic["status"],
        "seat_limit": lic["seat_limit"],
        "monthly_page_limit": lic["monthly_page_limit"],
        "pages_used_this_month": lic["pages_used_this_month"],
    }


# Serve static Web Checker + Before/After samples from apps/web/
if WEB_DIR.exists():
    app.mount("/samples", StaticFiles(directory=str(WEB_DIR / "samples")), name="samples")

    @app.get("/")
    def serve_index():
        return FileResponse(str(WEB_DIR / "index.html"))

    @app.get("/pdfua_inspector.js")
    def serve_inspector():
        return FileResponse(str(WEB_DIR / "pdfua_inspector.js"), media_type="application/javascript")

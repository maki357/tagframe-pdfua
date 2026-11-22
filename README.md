# TagFrame PDF/UA

**Source-level ISO 14289-1 (PDF/UA-1) accessibility tooling for Figma Design & Figma Slides.**

- **Live Zero-Upload PDF/UA-1 Checker (100% Browser-Side):** [https://maki357.github.io/tagframe-pdfua/](https://maki357.github.io/tagframe-pdfua/)
- Zero bytes leave your computer when inspecting PDFs in the browser checker (native Web `DecompressionStream` parser for `/FlateDecode` & compressed PDF 1.5+ `/ObjStm` streams).
- Includes real downloadable **Before (untagged outlined PDF)** vs. **After (Typst 0.15 `ua-1` tagged PDF/UA-1)** samples you can open directly in **PAC 2024**, **veraPDF**, or **Adobe Acrobat Pro**.

## Repository Structure

- `apps/web/` — Zero-dependency client-side ISO 14289-1 structural inspector (`pdfua_inspector.js`), web UI (`index.html`), and Before/After PDF proofs (`samples/`).
- `apps/figma-plugin/` — Installable Figma Design & Figma Slides plugin (`manifest.json`, `src/engine.mjs`, `src/code.js`, `dist/code.js`, `src/ui.html`) with persistent `node.setPluginData("tagframe_v1", ...)` tagging and WCAG 2.1 AA Dry-Run Preflight.
- `apps/api/` — Stateless in-RAM FastAPI + `Typst 0.15` (`pdf_standards=["ua-1"]`) compiler, Paddle Billing webhook state machine (`BIGINT` cents, ISO-4217 validation, UTC timestamps, idempotency, out-of-order & concurrent quota guards), and `Dockerfile`.
- `tests/` — Automated Python + Node.js state-machine, edge-case, and end-to-end compilation + inspection tests.

## Quick Local Verification

```bash
# Run API & Billing State-Machine tests (6/6)
python tests/test_api_and_state_machine.py

# Run Zero-Upload PDF/UA-1 Inspector unit & edge-case tests (7/7)
node tests/pdfua_inspector.test.mjs

# Run Figma Plugin Engine & full E2E Typst PDF/UA-1 -> Inspector tests (5/5)
node tests/test_plugin_engine_and_e2e.mjs

# Rebuild Figma Plugin bundle (dist/code.js)
node apps/figma-plugin/scripts/build.mjs
```

## Load the Plugin in Figma Desktop

1. Open Figma Desktop (Design or Figma Slides).
2. Go to **Plugins → Development → Import plugin from manifest...**
3. Select `apps/figma-plugin/manifest.json`.

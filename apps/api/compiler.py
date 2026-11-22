"""
Stateless In-Memory Figma Scene JSON -> ISO 14289-1 (PDF/UA-1) Compiler.
Uses Typst 0.15+ (`pdf_standards=["ua-1"]`) inside an ephemeral temporary directory
that is immediately wiped after returning PDF bytes in RAM (zero persistent client files).
"""
from __future__ import annotations

import base64
import os
import re
import tempfile
import time
from typing import Any
import typst

MAX_FRAMES = 100
MAX_NODES_PER_FRAME = 500
VALID_LANG_RE = re.compile(r"^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})?$")
VALID_HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


def escape_typst_content(text: str) -> str:
    """Escape Typst markup special characters so arbitrary user copy cannot inject Typst code."""
    if not text:
        return ""
    replacements = {
        "\\": "\\\\",
        "#": "\\#",
        "*": "\\*",
        "_": "\\_",
        "`": "\\`",
        "$": "\\$",
        "@": "\\@",
        "<": "\\<",
        ">": "\\>",
        "[": "\\[",
        "]": "\\]",
        "~": "\\~",
    }
    out = []
    for ch in text:
        out.append(replacements.get(ch, ch))
    return "".join(out)


def escape_typst_string(text: str) -> str:
    """Escape a double-quoted Typst string literal."""
    return (text or "").replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ").replace("\r", " ")


def sanitize_hex(color: str, fallback: str = "#0F172A") -> str:
    c = (color or "").strip()
    return c if VALID_HEX_RE.match(c) else fallback


def split_lang_region(lang_tag: str) -> tuple[str, str]:
    raw = (lang_tag or "en-US").strip()
    if not VALID_LANG_RE.match(raw):
        return ("en", "US")
    parts = raw.split("-")
    lang = parts[0].lower()
    region = parts[1].upper() if len(parts) > 1 and len(parts[1]) == 2 else ""
    return (lang, region)


def compile_figma_scene_to_pdfua1(scene: dict[str, Any]) -> tuple[bytes, dict[str, Any]]:
    """
    Convert structured Figma Design / Figma Slides JSON scene into a real ISO 14289-1 PDF/UA-1 binary.
    Returns: (pdf_bytes, telemetry_dict)
    """
    t0 = time.perf_counter()

    doc_title = (scene.get("title") or "Untitled Accessible Document").strip()[:200]
    doc_author = (scene.get("author") or "TagFrame PDF/UA").strip()[:120]
    lang_code, region_code = split_lang_region(scene.get("lang") or "en-US")
    frames = scene.get("frames") or []

    if not isinstance(frames, list) or len(frames) == 0:
        raise ValueError("Scene must include at least 1 frame/slide.")
    if len(frames) > MAX_FRAMES:
        raise ValueError(f"Scene exceeds MVP limit of {MAX_FRAMES} frames per export.")

    lines: list[str] = [
        f'#set document(title: "{escape_typst_string(doc_title)}", author: "{escape_typst_string(doc_author)}")',
        '#set text(font: ("DejaVu Sans", "Liberation Sans", "Segoe UI", "Arial"), size: 13pt, fill: rgb("#0F172A"), '
        + (f'lang: "{lang_code}", region: "{region_code}")' if region_code else f'lang: "{lang_code}")'),
    ]

    compiled_nodes = 0
    skipped_deleted = list(scene.get("skippedDeletedNodes") or [])

    with tempfile.TemporaryDirectory(prefix="tagframe_mem_") as tmpdir:
        for f_idx, frame in enumerate(frames):
            w_pt = max(144, min(2880, int(frame.get("width") or 960)))
            h_pt = max(144, min(2880, int(frame.get("height") or 540)))
            bg_hex = sanitize_hex(frame.get("backgroundColor") or "#FFFFFF", "#FFFFFF")
            nodes = frame.get("nodes") or []
            if len(nodes) > MAX_NODES_PER_FRAME:
                raise ValueError(f"Frame {f_idx + 1} exceeds {MAX_NODES_PER_FRAME} nodes limit.")

            if f_idx > 0:
                lines.append("#pagebreak()")
            lines.append(f'#set page(width: {w_pt}pt, height: {h_pt}pt, margin: (x: 48pt, y: 40pt), fill: rgb("{bg_hex}"))')

            # Sort by explicit readingOrder (stable deterministic order)
            ordered = sorted(
                [n for n in nodes if n.get("visible", True) is not False],
                key=lambda n: int(n.get("readingOrder", 0)),
            )
            hidden_in_frame = [n.get("id", "unknown") for n in nodes if n.get("visible", True) is False]
            skipped_deleted.extend(hidden_in_frame)

            if not ordered:
                lines.append('#pdf.artifact[#rect(width: 1pt, height: 1pt, fill: none)]')
                continue

            for n_idx, node in enumerate(ordered):
                role = (node.get("role") or "P").strip()
                text = (node.get("text") or "").strip()
                color = sanitize_hex(node.get("color") or "#0F172A", "#0F172A")
                font_size = max(8, min(96, int(node.get("fontSize") or 13)))
                weight = "bold" if str(node.get("fontWeight", "regular")).lower() in ("bold", "700", "800", "600") else "regular"
                compiled_nodes += 1

                if role == "Artifact":
                    if text:
                        lines.append(f'#pdf.artifact[#text(size: {font_size}pt, fill: rgb("{color}"))[{escape_typst_content(text)}]]')
                    else:
                        lines.append(f'#pdf.artifact[#rect(width: 100%, height: 6pt, radius: 3pt, fill: rgb("{color}"))]')
                elif role in ("H1", "H2", "H3", "H4", "H5", "H6"):
                    lvl = int(role[1])
                    safe_txt = escape_typst_content(text or f"Section {n_idx + 1}")
                    lines.append(f'#v(6pt)\n#heading(level: {lvl})[#text(size: {font_size}pt, weight: "bold", fill: rgb("{color}"))[{safe_txt}]]\n#v(4pt)')
                elif role == "List":
                    items = node.get("items") or ([line.strip("-• ").strip() for line in text.splitlines() if line.strip()] if text else [])
                    for item in items:
                        lines.append(f'- #text(size: {font_size}pt, fill: rgb("{color}"))[{escape_typst_content(item)}]')
                    lines.append("#v(4pt)")
                elif role == "Link":
                    url = (node.get("url") or "https://example.com").strip()
                    if not (url.startswith("https://") or url.startswith("http://") or url.startswith("mailto:")):
                        url = "https://example.com"
                    label = escape_typst_content(text or url)
                    lines.append(f'#link("{escape_typst_string(url)}")[#text(size: {font_size}pt, fill: rgb("#0F766E"))[{label}]]\n#v(4pt)')
                elif role == "Table":
                    headers = node.get("headers") or []
                    rows = node.get("rows") or []
                    col_count = max(1, len(headers) if headers else (len(rows[0]) if rows else 1))
                    cols_spec = ", ".join(["1fr"] * col_count)
                    lines.append(f'#v(6pt)\n#table(columns: ({cols_spec}), inset: 8pt, stroke: 0.6pt + rgb("#CBD5E1"),')
                    if headers:
                        hdr_cells = ", ".join(f'[#text(weight: "bold")[{escape_typst_content(str(h))}]]' for h in headers[:col_count])
                        lines.append(f"  table.header({hdr_cells}),")
                    for r_row in rows:
                        padded = list(r_row)[:col_count] + [""] * max(0, col_count - len(r_row))
                        cells = ", ".join(f"[{escape_typst_content(str(c))}]" for c in padded)
                        lines.append(f"  {cells},")
                    lines.append(")\n#v(6pt)")
                elif role == "Figure":
                    alt_text = (node.get("alt") or "").strip()
                    if not alt_text:
                        raise ValueError(f"Figure node '{node.get('id', n_idx)}' is missing required Alt text for ISO 14289-1.")
                    img_b64 = node.get("imageBase64")
                    if img_b64:
                        img_name = f"fig_{f_idx}_{n_idx}.png"
                        img_path = os.path.join(tmpdir, img_name)
                        raw_img = base64.b64decode(img_b64.split(",")[-1])
                        with open(img_path, "wb") as img_f:
                            img_f.write(raw_img)
                        lines.append(f'#figure(image("{img_name}", width: 85%), alt: "{escape_typst_string(alt_text)}")\n#v(6pt)')
                    else:
                        caption_txt = escape_typst_content(text or alt_text)
                        lines.append(
                            f'#figure(rect(width: 100%, height: 54pt, radius: 6pt, fill: rgb("#E2E8F0"), stroke: 0.75pt + rgb("#94A3B8"))'
                            f'[#align(center + horizon)[#text(size: 12pt, weight: "bold", fill: rgb("#0F172A"))[{caption_txt}]]], '
                            f'alt: "{escape_typst_string(alt_text)}")\n#v(6pt)'
                        )
                else:
                    # Default Paragraph P
                    if text:
                        lines.append(f'#text(size: {font_size}pt, weight: "{weight}", fill: rgb("{color}"))[{escape_typst_content(text)}]\n\n#v(4pt)')

        typ_path = os.path.join(tmpdir, "doc.typ")
        with open(typ_path, "w", encoding="utf-8") as f:
            f.write("\n".join(lines))

        pdf_bytes, warnings = typst.compile_with_warnings(
            typ_path,
            root=tmpdir,
            format="pdf",
            pdf_standards=["ua-1"],
            pdf_tags=True,
        )

    elapsed_ms = int((time.perf_counter() - t0) * 1000)
    telemetry = {
        "standard": "ISO-14289-1-UA1",
        "typst_version": getattr(typst, "__version__", "unknown"),
        "frames_compiled": len(frames),
        "nodes_compiled": compiled_nodes,
        "skipped_deleted_nodes": skipped_deleted,
        "pdf_size_bytes": len(pdf_bytes),
        "compile_ms": elapsed_ms,
        "warnings": [str(w) for w in warnings],
    }
    return pdf_bytes, telemetry

"""
Stateless In-Memory Figma Scene JSON -> ISO 14289-1 (PDF/UA-1) Compiler.
Uses Typst 0.15+ (`pdf_standards=["ua-1"]`) inside an ephemeral temporary directory
that is immediately wiped after returning PDF bytes in RAM (zero persistent client files).

Supports both:
- `layoutMode="flow"` (default, backwards-compatible accessible reflow)
- `layoutMode="positioned"` (Hybrid Coordinate-Faithful PDF/UA-1: exact Figma `(x, y, width, height)`
  geometry with optional full-bleed `backgroundImageBase64` Artifact + strict deterministic `/StructTreeRoot`
  reading order + ephemeral `customFonts` via Typst `font_paths`).
"""
from __future__ import annotations

import base64
import binascii
import math
import os
import re
import struct
import tempfile
import time
from typing import Any
import typst

MAX_FRAMES = 100
MAX_NODES_PER_FRAME = 500
MAX_CUSTOM_FONTS = 5
MAX_CUSTOM_FONT_BYTES = 5 * 1024 * 1024  # 5 MB per font
MAX_IMAGE_BYTES = 10 * 1024 * 1024       # 10 MB per PNG/JPEG image

VALID_LANG_RE = re.compile(r"^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})?$")
VALID_HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
VALID_FONT_FILENAME_RE = re.compile(r"^[A-Za-z0-9._-]+\.(ttf|otf)$", re.IGNORECASE)
VALID_FONT_FAMILY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 \-]{0,63}$")

DEFAULT_FONT_FALLBACKS = ("DejaVu Sans", "Liberation Sans", "Segoe UI", "Arial")
VALID_SFNT_MAGICS = (b"\x00\x01\x00\x00", b"OTTO", b"true", b"typ1", b"ttcf")


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


def _safe_float(val: Any, default: float = 0.0) -> float:
    if val is None or isinstance(val, bool):
        return default
    try:
        f = float(val)
        return f if math.isfinite(f) else default
    except (TypeError, ValueError):
        return default


def _safe_int(val: Any, default: int = 0) -> int:
    if val is None or isinstance(val, bool):
        return default
    try:
        f = float(val)
        return int(round(f)) if math.isfinite(f) else default
    except (TypeError, ValueError):
        return default


def _fmt_pt(val: float) -> str:
    rounded = round(val, 2)
    if rounded == int(rounded):
        return f"{int(rounded)}pt"
    return f"{rounded:.2f}".rstrip("0").rstrip(".") + "pt"


def _sanitize_font_family(name: Any) -> str | None:
    if not isinstance(name, str):
        return None
    cleaned = " ".join(name.strip().split())
    if cleaned and VALID_FONT_FAMILY_RE.match(cleaned):
        return cleaned
    return None


def _format_font_list_typst(families: list[str]) -> str:
    seen: set[str] = set()
    ordered: list[str] = []
    for fam in families:
        key = fam.lower()
        if fam and key not in seen:
            seen.add(key)
            ordered.append(fam)
    return "(" + ", ".join(f'"{escape_typst_string(f)}"' for f in ordered) + ")"


def _strip_data_uri_base64(b64_str: str) -> str:
    s = b64_str.strip()
    if s.lower().startswith("data:") and "," in s:
        s = s.split(",", 1)[1]
    return "".join(s.split())


def decode_and_validate_image_b64(b64_str: Any, label: str) -> tuple[bytes, str]:
    """Decode base64 image and enforce PNG/JPEG magic bytes and 10 MB decoded size limit."""
    if not isinstance(b64_str, str) or not b64_str.strip():
        raise ValueError(f"{label} must be a non-empty base64 string.")
    payload = _strip_data_uri_base64(b64_str)
    if len(payload) > (MAX_IMAGE_BYTES * 4 // 3) + 16:
        raise ValueError(f"{label} exceeds 10 MB limit.")
    try:
        raw = base64.b64decode(payload, validate=True)
    except (ValueError, binascii.Error):
        raise ValueError(f"{label} contains invalid base64 data.")
    if len(raw) == 0:
        raise ValueError(f"{label} is empty.")
    if len(raw) > MAX_IMAGE_BYTES:
        raise ValueError(f"{label} exceeds 10 MB limit.")
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return raw, "png"
    if raw.startswith(b"\xff\xd8\xff"):
        return raw, "jpg"
    raise ValueError(f"{label} must be a valid PNG or JPEG image (magic bytes mismatch).")


def extract_sfnt_family_name(font_bytes: bytes) -> str | None:
    """Extract the OpenType/TrueType font family name (nameID 16 or 1) using stdlib struct only."""
    if len(font_bytes) < 12 or font_bytes[:4] not in (b"\x00\x01\x00\x00", b"OTTO", b"true"):
        return None
    num_tables = struct.unpack(">H", font_bytes[4:6])[0]
    name_offset = None
    for i in range(num_tables):
        pos = 12 + i * 16
        if pos + 16 > len(font_bytes):
            break
        tag, _, offset, _ = struct.unpack(">4sIII", font_bytes[pos : pos + 16])
        if tag == b"name":
            name_offset = offset
            break
    if name_offset is None or name_offset + 6 > len(font_bytes):
        return None
    _, count, string_offset = struct.unpack(">HHH", font_bytes[name_offset : name_offset + 6])
    storage_start = name_offset + string_offset
    best_prio = (0, 0)
    best_val: str | None = None
    for i in range(count):
        rec = name_offset + 6 + i * 12
        if rec + 12 > len(font_bytes):
            break
        platform_id, _, lang_id, name_id, length, offset = struct.unpack(">HHHHHH", font_bytes[rec : rec + 12])
        if name_id not in (1, 16):
            continue
        s_start = storage_start + offset
        s_end = s_start + length
        if s_end > len(font_bytes):
            continue
        raw = font_bytes[s_start:s_end]
        try:
            if platform_id in (0, 3):
                val = raw.decode("utf-16-be").strip()
            elif platform_id == 1:
                val = raw.decode("mac_roman", errors="ignore").strip()
            else:
                continue
        except Exception:
            continue
        if val:
            prio = (2 if name_id == 16 else 1, 2 if (platform_id == 3 and lang_id == 0x0409) else 1)
            if prio > best_prio:
                best_prio = prio
                best_val = val
    return best_val


def validate_and_decode_custom_fonts(custom_fonts: Any) -> list[tuple[str, bytes, str | None]]:
    """
    Strictly validate `customFonts` array:
    - Max 5 fonts, max 5 MB decoded each
    - Basename strictly matches ^[A-Za-z0-9._-]+\\.(ttf|otf)$ with zero path traversal
    - Valid OpenType/TrueType sfnt header magic bytes
    Returns list of (safe_filename, raw_bytes, safe_family_name).
    """
    if custom_fonts is None:
        return []
    if not isinstance(custom_fonts, list):
        raise ValueError("customFonts must be a list of {filename, base64} objects.")
    if len(custom_fonts) > MAX_CUSTOM_FONTS:
        raise ValueError(f"customFonts exceeds maximum of {MAX_CUSTOM_FONTS} fonts per export.")

    decoded: list[tuple[str, bytes, str | None]] = []
    seen_names: set[str] = set()
    for idx, item in enumerate(custom_fonts):
        if not isinstance(item, dict):
            raise ValueError(f"customFonts[{idx}] must be an object with filename and base64.")
        filename = item.get("filename")
        if not isinstance(filename, str) or not filename:
            raise ValueError(f"customFonts[{idx}] is missing a valid filename.")
        if (
            "/" in filename
            or "\\" in filename
            or ".." in filename
            or filename.startswith(".")
            or os.path.basename(filename) != filename
            or not VALID_FONT_FILENAME_RE.match(filename)
        ):
            raise ValueError(
                f"Invalid custom font filename '{filename}': must match ^[A-Za-z0-9._-]+\\.(ttf|otf)$ without path traversal."
            )
        lower_fn = filename.lower()
        if lower_fn in seen_names:
            raise ValueError(f"Duplicate custom font filename '{filename}'.")
        seen_names.add(lower_fn)

        b64_val = item.get("base64")
        if not isinstance(b64_val, str) or not b64_val.strip():
            raise ValueError(f"Custom font '{filename}' is missing base64 data.")
        payload = _strip_data_uri_base64(b64_val)
        if len(payload) > (MAX_CUSTOM_FONT_BYTES * 4 // 3) + 16:
            raise ValueError(f"Custom font '{filename}' exceeds 5 MB limit.")
        try:
            raw_font = base64.b64decode(payload, validate=True)
        except (ValueError, binascii.Error):
            raise ValueError(f"Custom font '{filename}' contains invalid base64 data.")
        if len(raw_font) == 0:
            raise ValueError(f"Custom font '{filename}' is empty.")
        if len(raw_font) > MAX_CUSTOM_FONT_BYTES:
            raise ValueError(f"Custom font '{filename}' exceeds 5 MB limit.")
        if len(raw_font) < 4 or raw_font[:4] not in VALID_SFNT_MAGICS:
            raise ValueError(f"Custom font '{filename}' is not a valid TTF/OTF font binary.")

        extracted_family = _sanitize_font_family(extract_sfnt_family_name(raw_font))
        if not extracted_family:
            stem = os.path.splitext(filename)[0]
            extracted_family = _sanitize_font_family(re.sub(r"[-_]+", " ", stem))
        decoded.append((filename, raw_font, extracted_family))

    return decoded


def validate_scene_inputs(scene: dict[str, Any]) -> tuple[str, list[dict[str, Any]], list[tuple[str, bytes, str | None]]]:
    """Validate top-level scene contract before compiling (also callable prior to license quota deduction)."""
    if not isinstance(scene, dict):
        raise ValueError("Scene payload must be a JSON object.")

    raw_mode = scene.get("layoutMode")
    if raw_mode is None or raw_mode == "":
        layout_mode = "flow"
    elif isinstance(raw_mode, str) and raw_mode.strip().lower() in ("flow", "positioned"):
        layout_mode = raw_mode.strip().lower()
    else:
        raise ValueError("Invalid layoutMode: must be 'flow' or 'positioned'.")

    frames = scene.get("frames")
    if not isinstance(frames, list) or len(frames) == 0:
        raise ValueError("Scene must include at least 1 frame/slide.")
    if len(frames) > MAX_FRAMES:
        raise ValueError(f"Scene exceeds MVP limit of {MAX_FRAMES} frames per export.")

    for f_idx, frame in enumerate(frames):
        if not isinstance(frame, dict):
            raise ValueError(f"Frame {f_idx + 1} must be an object.")
        nodes = frame.get("nodes") or []
        if not isinstance(nodes, list):
            raise ValueError(f"Frame {f_idx + 1} nodes must be a list.")
        if len(nodes) > MAX_NODES_PER_FRAME:
            raise ValueError(f"Frame {f_idx + 1} exceeds {MAX_NODES_PER_FRAME} nodes limit.")

    decoded_fonts = validate_and_decode_custom_fonts(scene.get("customFonts"))
    return layout_mode, frames, decoded_fonts


def _render_positioned_box(
    x_pt: float,
    y_pt: float,
    box_w: float,
    inner_markup: str,
    node_font_prefix: str = "",
) -> str:
    return (
        f"#place(top + left, dx: {_fmt_pt(x_pt)}, dy: {_fmt_pt(y_pt)})["
        f"#box(width: {_fmt_pt(box_w)})[{node_font_prefix}{inner_markup}]]"
    )


def compile_figma_scene_to_pdfua1(scene: dict[str, Any]) -> tuple[bytes, dict[str, Any]]:
    """
    Convert structured Figma Design / Figma Slides JSON scene into a real ISO 14289-1 PDF/UA-1 binary.
    Returns: (pdf_bytes, telemetry_dict)
    """
    t0 = time.perf_counter()

    layout_mode, frames, decoded_fonts = validate_scene_inputs(scene)

    doc_title = (str(scene.get("title") or "Untitled Accessible Document")).strip()[:200]
    doc_author = (str(scene.get("author") or "TagFrame PDF/UA")).strip()[:120]
    lang_code, region_code = split_lang_region(str(scene.get("lang") or "en-US"))

    custom_font_families: list[str] = [fam for _, _, fam in decoded_fonts if fam]
    base_font_stack: list[str] = custom_font_families + list(DEFAULT_FONT_FALLBACKS)
    base_font_typst = _format_font_list_typst(base_font_stack)

    lines: list[str] = [
        f'#set document(title: "{escape_typst_string(doc_title)}", author: "{escape_typst_string(doc_author)}")',
        f'#set text(font: {base_font_typst}, size: 13pt, fill: rgb("#0F172A"), '
        + (f'lang: "{lang_code}", region: "{region_code}")' if region_code else f'lang: "{lang_code}")'),
    ]

    compiled_nodes = 0
    skipped_deleted = list(scene.get("skippedDeletedNodes") or [])

    with tempfile.TemporaryDirectory(prefix="tagframe_mem_") as tmpdir:
        font_paths: list[str] = []
        if decoded_fonts:
            fonts_dir = os.path.join(tmpdir, "fonts")
            os.makedirs(fonts_dir, exist_ok=True)
            real_fonts_dir = os.path.realpath(fonts_dir)
            for fname, raw_font, _ in decoded_fonts:
                dest_path = os.path.join(fonts_dir, fname)
                if os.path.commonpath([real_fonts_dir, os.path.realpath(dest_path)]) != real_fonts_dir:
                    raise ValueError(f"Path traversal rejected for custom font '{fname}'.")
                with open(dest_path, "wb") as ff:
                    ff.write(raw_font)
            font_paths.append(fonts_dir)

        for f_idx, frame in enumerate(frames):
            w_pt = max(144, min(2880, _safe_int(frame.get("width"), 960)))
            h_pt = max(144, min(2880, _safe_int(frame.get("height"), 540)))
            bg_hex = sanitize_hex(frame.get("backgroundColor") or "#FFFFFF", "#FFFFFF")
            nodes = frame.get("nodes") or []

            if f_idx > 0:
                lines.append("#pagebreak()")

            if layout_mode == "positioned":
                lines.append(f'#set page(width: {w_pt}pt, height: {h_pt}pt, margin: 0pt, fill: rgb("{bg_hex}"))')
            else:
                lines.append(
                    f'#set page(width: {w_pt}pt, height: {h_pt}pt, margin: (x: 48pt, y: 40pt), fill: rgb("{bg_hex}"))'
                )

            has_bg_image = False
            bg_img_b64 = frame.get("backgroundImageBase64")
            if bg_img_b64:
                raw_bg, bg_ext = decode_and_validate_image_b64(
                    bg_img_b64, f"Frame {f_idx + 1} backgroundImageBase64"
                )
                if layout_mode == "positioned":
                    bg_name = f"bg_{f_idx}.{bg_ext}"
                    with open(os.path.join(tmpdir, bg_name), "wb") as bg_f:
                        bg_f.write(raw_bg)
                    lines.append(
                        f'#pdf.artifact[#place(top + left)[#image("{bg_name}", width: {w_pt}pt, height: {h_pt}pt, fit: "stretch")]]'
                    )
                    has_bg_image = True

            # Sort by explicit readingOrder (stable deterministic order)
            ordered = sorted(
                [n for n in nodes if isinstance(n, dict) and n.get("visible", True) is not False],
                key=lambda n: _safe_int(n.get("readingOrder"), 0),
            )
            hidden_in_frame = [
                n.get("id", "unknown")
                for n in nodes
                if isinstance(n, dict) and n.get("visible", True) is False
            ]
            skipped_deleted.extend(hidden_in_frame)

            if not ordered:
                if not has_bg_image:
                    lines.append("#pdf.artifact[#rect(width: 1pt, height: 1pt, fill: none)]")
                continue

            for n_idx, node in enumerate(ordered):
                role = (str(node.get("role") or "P")).strip()
                text = (str(node.get("text") or "")).strip()
                color = sanitize_hex(node.get("color") or "#0F172A", "#0F172A")
                font_size = max(8, min(96, _safe_int(node.get("fontSize"), 13)))
                weight = (
                    "bold"
                    if str(node.get("fontWeight", "regular")).lower() in ("bold", "700", "800", "600")
                    else "regular"
                )
                safe_node_font = _sanitize_font_family(node.get("fontFamily"))
                node_font_prefix = (
                    f"#set text(font: {_format_font_list_typst([safe_node_font] + base_font_stack)})\n"
                    if safe_node_font
                    else ""
                )
                compiled_nodes += 1

                if layout_mode == "positioned":
                    raw_x = _safe_float(node.get("x"), 0.0)
                    raw_y = _safe_float(node.get("y"), 0.0)
                    raw_w = _safe_float(node.get("width"), 0.0)
                    raw_h = _safe_float(node.get("height"), 0.0)

                    x_pt = max(0.0, min(float(w_pt) - 24.0, raw_x))
                    y_pt = max(0.0, min(float(h_pt) - 16.0, raw_y))
                    if raw_w <= 0.0:
                        box_w = max(120.0, float(w_pt) - x_pt - 24.0)
                    else:
                        box_w = raw_w
                    max_avail_w = max(24.0, float(w_pt) - x_pt)
                    box_w = max(24.0, min(max_avail_w, box_w))

                    if role == "Artifact":
                        if text:
                            lines.append(
                                f"#pdf.artifact[{_render_positioned_box(x_pt, y_pt, box_w, f'#text(size: {font_size}pt, weight: \"{weight}\", fill: rgb(\"{color}\"))[{escape_typst_content(text)}]', node_font_prefix)}]"
                            )
                        else:
                            art_h = max(2.0, min(float(h_pt) - y_pt, raw_h)) if raw_h > 0.0 else 6.0
                            lines.append(
                                f'#pdf.artifact[#place(top + left, dx: {_fmt_pt(x_pt)}, dy: {_fmt_pt(y_pt)})['
                                f'#rect(width: {_fmt_pt(box_w)}, height: {_fmt_pt(art_h)}, radius: 3pt, fill: rgb("{color}"))]]'
                            )
                    elif role in ("H1", "H2", "H3", "H4", "H5", "H6"):
                        lvl = int(role[1])
                        safe_txt = escape_typst_content(text or f"Section {n_idx + 1}")
                        inner = f'#heading(level: {lvl})[#text(size: {font_size}pt, weight: "bold", fill: rgb("{color}"))[{safe_txt}]]'
                        lines.append(_render_positioned_box(x_pt, y_pt, box_w, inner, node_font_prefix))
                    elif role == "List":
                        raw_items = node.get("items") or (
                            [line.strip("-• ").strip() for line in text.splitlines() if line.strip()] if text else []
                        )
                        items = [str(it).strip() for it in raw_items if str(it).strip()]
                        if items:
                            bullet_lines = "\n".join(
                                f'- #text(size: {font_size}pt, fill: rgb("{color}"))[{escape_typst_content(item)}]'
                                for item in items
                            )
                            lines.append(_render_positioned_box(x_pt, y_pt, box_w, f"\n{bullet_lines}\n", node_font_prefix))
                    elif role == "Link":
                        url = (str(node.get("url") or "https://example.com")).strip()
                        if not (url.startswith("https://") or url.startswith("http://") or url.startswith("mailto:")):
                            url = "https://example.com"
                        label = escape_typst_content(text or url)
                        inner = f'#par[#link("{escape_typst_string(url)}")[#text(size: {font_size}pt, fill: rgb("#0F766E"))[{label}]]]'
                        lines.append(_render_positioned_box(x_pt, y_pt, box_w, inner, node_font_prefix))
                    elif role == "Table":
                        headers = node.get("headers") or []
                        rows = node.get("rows") or []
                        if headers or rows:
                            col_count = max(1, len(headers) if headers else (len(rows[0]) if rows else 1))
                            cols_spec = ", ".join(["1fr"] * col_count)
                            tbl_lines = [f'#table(columns: ({cols_spec}), inset: 6pt, stroke: 0.6pt + rgb("#CBD5E1"),']
                            if headers:
                                hdr_cells = ", ".join(
                                    f'[#text(weight: "bold")[{escape_typst_content(str(h))}]]'
                                    for h in headers[:col_count]
                                )
                                tbl_lines.append(f"  table.header({hdr_cells}),")
                            for r_row in rows:
                                padded = list(r_row)[:col_count] + [""] * max(0, col_count - len(r_row))
                                cells = ", ".join(f"[{escape_typst_content(str(c))}]" for c in padded)
                                tbl_lines.append(f"  {cells},")
                            tbl_lines.append(")")
                            lines.append(
                                _render_positioned_box(x_pt, y_pt, box_w, "\n".join(tbl_lines), node_font_prefix)
                            )
                    elif role == "Figure":
                        alt_text = (str(node.get("alt") or "")).strip()
                        if not alt_text:
                            raise ValueError(
                                f"Figure node '{node.get('id', n_idx)}' is missing required Alt text for ISO 14289-1."
                            )
                        img_b64 = node.get("imageBase64")
                        if img_b64:
                            raw_img, img_ext = decode_and_validate_image_b64(
                                img_b64, f"Figure node '{node.get('id', n_idx)}' imageBase64"
                            )
                            img_name = f"fig_{f_idx}_{n_idx}.{img_ext}"
                            with open(os.path.join(tmpdir, img_name), "wb") as img_f:
                                img_f.write(raw_img)
                            if raw_h > 0.0:
                                fig_h = max(16.0, min(float(h_pt) - y_pt, raw_h))
                                img_expr = f'image("{img_name}", width: 100%, height: {_fmt_pt(fig_h)}, fit: "contain")'
                            else:
                                img_expr = f'image("{img_name}", width: 100%)'
                            inner = f'#figure({img_expr}, alt: "{escape_typst_string(alt_text)}")'
                        else:
                            caption_txt = escape_typst_content(text or alt_text)
                            fig_h = max(24.0, min(float(h_pt) - y_pt, raw_h)) if raw_h > 0.0 else 54.0
                            inner = (
                                f'#figure(rect(width: 100%, height: {_fmt_pt(fig_h)}, radius: 6pt, fill: rgb("#E2E8F0"), stroke: 0.75pt + rgb("#94A3B8"))'
                                f'[#align(center + horizon)[#text(size: 12pt, weight: "bold", fill: rgb("#0F172A"))[{caption_txt}]]], '
                                f'alt: "{escape_typst_string(alt_text)}")'
                            )
                        lines.append(_render_positioned_box(x_pt, y_pt, box_w, inner, node_font_prefix))
                    else:
                        # Default Paragraph P in positioned box: wrap each paragraph in #par[...] for clean <P> tags
                        if text:
                            chunks = [c.strip() for c in re.split(r"\n\s*\n", text) if c.strip()]
                            pars = "\n".join(
                                f'#par[#text(size: {font_size}pt, weight: "{weight}", fill: rgb("{color}"))[{escape_typst_content(chunk)}]]'
                                for chunk in chunks
                            )
                            lines.append(_render_positioned_box(x_pt, y_pt, box_w, pars, node_font_prefix))
                else:
                    # Backwards-compatible flow layout mode
                    def _wrap_flow_font(markup: str) -> str:
                        if not node_font_prefix:
                            return markup
                        return f"#[{node_font_prefix}{markup}\n]"

                    if role == "Artifact":
                        if text:
                            lines.append(
                                _wrap_flow_font(
                                    f'#pdf.artifact[#text(size: {font_size}pt, fill: rgb("{color}"))[{escape_typst_content(text)}]]'
                                )
                            )
                        else:
                            lines.append(
                                f'#pdf.artifact[#rect(width: 100%, height: 6pt, radius: 3pt, fill: rgb("{color}"))]'
                            )
                    elif role in ("H1", "H2", "H3", "H4", "H5", "H6"):
                        lvl = int(role[1])
                        safe_txt = escape_typst_content(text or f"Section {n_idx + 1}")
                        lines.append(
                            _wrap_flow_font(
                                f'#v(6pt)\n#heading(level: {lvl})[#text(size: {font_size}pt, weight: "bold", fill: rgb("{color}"))[{safe_txt}]]\n#v(4pt)'
                            )
                        )
                    elif role == "List":
                        raw_items = node.get("items") or (
                            [line.strip("-• ").strip() for line in text.splitlines() if line.strip()] if text else []
                        )
                        items = [str(it).strip() for it in raw_items if str(it).strip()]
                        if items:
                            block = "\n".join(
                                f'- #text(size: {font_size}pt, fill: rgb("{color}"))[{escape_typst_content(item)}]'
                                for item in items
                            )
                            lines.append(_wrap_flow_font(f"{block}\n#v(4pt)"))
                    elif role == "Link":
                        url = (str(node.get("url") or "https://example.com")).strip()
                        if not (url.startswith("https://") or url.startswith("http://") or url.startswith("mailto:")):
                            url = "https://example.com"
                        label = escape_typst_content(text or url)
                        lines.append(
                            _wrap_flow_font(
                                f'#link("{escape_typst_string(url)}")[#text(size: {font_size}pt, fill: rgb("#0F766E"))[{label}]]\n#v(4pt)'
                            )
                        )
                    elif role == "Table":
                        headers = node.get("headers") or []
                        rows = node.get("rows") or []
                        if headers or rows:
                            col_count = max(1, len(headers) if headers else (len(rows[0]) if rows else 1))
                            cols_spec = ", ".join(["1fr"] * col_count)
                            tbl_lines = [
                                f'#v(6pt)\n#table(columns: ({cols_spec}), inset: 8pt, stroke: 0.6pt + rgb("#CBD5E1"),'
                            ]
                            if headers:
                                hdr_cells = ", ".join(
                                    f'[#text(weight: "bold")[{escape_typst_content(str(h))}]]'
                                    for h in headers[:col_count]
                                )
                                tbl_lines.append(f"  table.header({hdr_cells}),")
                            for r_row in rows:
                                padded = list(r_row)[:col_count] + [""] * max(0, col_count - len(r_row))
                                cells = ", ".join(f"[{escape_typst_content(str(c))}]" for c in padded)
                                tbl_lines.append(f"  {cells},")
                            tbl_lines.append(")\n#v(6pt)")
                            lines.append(_wrap_flow_font("\n".join(tbl_lines)))
                    elif role == "Figure":
                        alt_text = (str(node.get("alt") or "")).strip()
                        if not alt_text:
                            raise ValueError(
                                f"Figure node '{node.get('id', n_idx)}' is missing required Alt text for ISO 14289-1."
                            )
                        img_b64 = node.get("imageBase64")
                        if img_b64:
                            raw_img, img_ext = decode_and_validate_image_b64(
                                img_b64, f"Figure node '{node.get('id', n_idx)}' imageBase64"
                            )
                            img_name = f"fig_{f_idx}_{n_idx}.{img_ext}"
                            with open(os.path.join(tmpdir, img_name), "wb") as img_f:
                                img_f.write(raw_img)
                            lines.append(
                                f'#figure(image("{img_name}", width: 85%), alt: "{escape_typst_string(alt_text)}")\n#v(6pt)'
                            )
                        else:
                            caption_txt = escape_typst_content(text or alt_text)
                            lines.append(
                                _wrap_flow_font(
                                    f'#figure(rect(width: 100%, height: 54pt, radius: 6pt, fill: rgb("#E2E8F0"), stroke: 0.75pt + rgb("#94A3B8"))'
                                    f'[#align(center + horizon)[#text(size: 12pt, weight: "bold", fill: rgb("#0F172A"))[{caption_txt}]]], '
                                    f'alt: "{escape_typst_string(alt_text)}")\n#v(6pt)'
                                )
                            )
                    else:
                        if text:
                            lines.append(
                                _wrap_flow_font(
                                    f'#text(size: {font_size}pt, weight: "{weight}", fill: rgb("{color}"))[{escape_typst_content(text)}]\n\n#v(4pt)'
                                )
                            )

        typ_path = os.path.join(tmpdir, "doc.typ")
        with open(typ_path, "w", encoding="utf-8") as f:
            f.write("\n".join(lines))

        compile_kwargs: dict[str, Any] = {
            "root": tmpdir,
            "format": "pdf",
            "pdf_standards": ["ua-1"],
            "pdf_tags": True,
        }
        if font_paths:
            compile_kwargs["font_paths"] = font_paths

        pdf_bytes, warnings = typst.compile_with_warnings(typ_path, **compile_kwargs)

    elapsed_ms = int((time.perf_counter() - t0) * 1000)
    telemetry = {
        "standard": "ISO-14289-1-UA1",
        "layout_mode": layout_mode,
        "custom_fonts_loaded": custom_font_families,
        "typst_version": getattr(typst, "__version__", "unknown"),
        "frames_compiled": len(frames),
        "nodes_compiled": compiled_nodes,
        "skipped_deleted_nodes": skipped_deleted,
        "pdf_size_bytes": len(pdf_bytes),
        "compile_ms": elapsed_ms,
        "warnings": [str(w) for w in warnings],
    }
    return pdf_bytes, telemetry

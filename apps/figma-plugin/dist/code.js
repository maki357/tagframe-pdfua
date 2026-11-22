"use strict";
(() => {
/**
 * TagFrame PDF/UA — Pure Deterministic Scene-Graph, Tag-Persistence & WCAG Dry-Run Preflight Engine.
 * Zero Figma runtime globals so every state-machine invariant can be unit-tested in Node.js.
 */

const PLUGIN_DATA_KEY = "tagframe_v1";
const OVERLAY_GROUP_NAME = "__TagFrame_ReadingOrder_Overlay__";
const DEFAULT_API_BASE_URL = "http://127.0.0.1:8000";
const VALID_ROLES = ["H1", "H2", "H3", "H4", "H5", "H6", "P", "List", "Link", "Table", "Figure", "Artifact"];
const VALID_LAYOUT_MODES = ["positioned", "flow"];
const MAX_CUSTOM_FONTS = 5;
const MAX_CUSTOM_FONT_BYTES = 5 * 1024 * 1024;

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Strict HTML entity escaping helper for safe text rendering (never raw HTML injection). */
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"'`]/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      case "`":
        return "&#96;";
      default:
        return ch;
    }
  });
}

/**
 * Validate and normalize the user-configured Compiler API base URL.
 * Allows https:// endpoints and local http://127.0.0.1 or http://localhost endpoints only.
 */
function normalizeApiBaseUrl(rawUrl, fallback = DEFAULT_API_BASE_URL) {
  const trimmed = String(rawUrl ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) {
    return { ok: true, url: fallback };
  }
  if (/[\s"'<>]/.test(trimmed)) {
    return { ok: false, error: "Compiler API URL must not contain whitespace or HTML characters." };
  }
  const httpsRe = /^https:\/\/[a-zA-Z0-9.-]+(?::\d{1,5})?(?:\/[a-zA-Z0-9._~:/?#[\]@!$&'()*+,;=-]*)?$/;
  const localHttpRe = /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d{1,5})?(?:\/[a-zA-Z0-9._~:/?#[\]@!$&'()*+,;=-]*)?$/;
  if (httpsRe.test(trimmed) || localHttpRe.test(trimmed)) {
    if (trimmed.includes("@")) {
      return { ok: false, error: "Compiler API URL must not include embedded credentials." };
    }
    return { ok: true, url: trimmed };
  }
  return {
    ok: false,
    error: "Compiler API URL must use https:// (or http://127.0.0.1 / http://localhost for local testing).",
  };
}

/**
 * Strictly sanitize a custom font filename to match backend validation `^[A-Za-z0-9._-]+\.(ttf|otf)$`.
 * Strips any directory components and rejects non-.ttf/.otf or traversal inputs.
 */
function sanitizeCustomFontFilename(rawName) {
  const base = String(rawName ?? "").replace(/\\/g, "/").split("/").pop() || "";
  const match = base.match(/^(.*)\.(ttf|otf)$/i);
  if (!match) return null;
  const rawStem = match[1].replace(/[^A-Za-z0-9._-]+/g, "_").replace(/\.{2,}/g, "_").replace(/^[._-]+/, "");
  const stem = rawStem || "custom_font";
  const ext = match[2].toLowerCase();
  const safe = `${stem}.${ext}`;
  if (!/^[A-Za-z0-9._-]+\.(ttf|otf)$/.test(safe) || safe.includes("..")) {
    return null;
  }
  return safe;
}

/**
 * Pure, chunked Uint8Array -> Base64 encoder without `String.fromCharCode(...bytes)`
 * so large 2x PNG exports and 5MB font files NEVER trigger a call-stack overflow.
 */
function uint8ArrayToBase64(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    bytes = new Uint8Array(bytes || 0);
  }
  const len = bytes.length;
  if (len === 0) return "";
  const chunks = [];
  const CHUNK_TRIPLETS = 4096; // 12,288 bytes per chunk -> safe string allocation
  const step = CHUNK_TRIPLETS * 3;
  for (let offset = 0; offset < len; offset += step) {
    const end = Math.min(len, offset + step);
    let out = "";
    let i = offset;
    for (; i + 2 < end; i += 3) {
      const triple = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      out +=
        BASE64_ALPHABET[(triple >> 18) & 63] +
        BASE64_ALPHABET[(triple >> 12) & 63] +
        BASE64_ALPHABET[(triple >> 6) & 63] +
        BASE64_ALPHABET[triple & 63];
    }
    const rem = end - i;
    if (rem === 1) {
      const b0 = bytes[i];
      out += BASE64_ALPHABET[(b0 >> 2) & 63] + BASE64_ALPHABET[(b0 << 4) & 63] + "==";
    } else if (rem === 2) {
      const pair = (bytes[i] << 8) | bytes[i + 1];
      out +=
        BASE64_ALPHABET[(pair >> 10) & 63] +
        BASE64_ALPHABET[(pair >> 4) & 63] +
        BASE64_ALPHABET[(pair << 2) & 63] +
        "=";
    }
    chunks.push(out);
  }
  return chunks.join("");
}

function round2(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function hasValidBoundingBox(box) {
  return Boolean(
    box &&
      typeof box === "object" &&
      Number.isFinite(Number(box.x)) &&
      Number.isFinite(Number(box.y))
  );
}

function computeRelativeGeometry(node, frameBox, offsetX, offsetY) {
  if (frameBox && hasValidBoundingBox(node.absoluteBoundingBox)) {
    const box = node.absoluteBoundingBox;
    const rawW = Number.isFinite(Number(box.width)) ? Number(box.width) : Number(node.width) || 0;
    const rawH = Number.isFinite(Number(box.height)) ? Number(box.height) : Number(node.height) || 0;
    return {
      x: round2(Number(box.x) - frameBox.x),
      y: round2(Number(box.y) - frameBox.y),
      width: Math.max(0, round2(rawW)),
      height: Math.max(0, round2(rawH)),
    };
  }
  return {
    x: round2(offsetX + (Number(node.x) || 0)),
    y: round2(offsetY + (Number(node.y) || 0)),
    width: Math.max(0, round2(Number(node.width) || 0)),
    height: Math.max(0, round2(Number(node.height) || 0)),
  };
}

function rgb01ToHex(r, g, b) {
  const clamp = (v) => Math.max(0, Math.min(255, Math.round((Number(v) || 0) * 255)));
  return (
    "#" +
    [clamp(r), clamp(g), clamp(b)]
      .map((n) => n.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()
  );
}

function hexToRgb255(hex) {
  const m = String(hex || "").trim().match(/^#([0-9a-fA-F]{6})$/);
  if (!m) return { r: 15, g: 23, b: 42 };
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** Exact WCAG 2.1 relative luminance & contrast ratio */
function relativeLuminance(hex) {
  const { r, g, b } = hexToRgb255(hex);
  const chan = [r, g, b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * chan[0] + 0.7152 * chan[1] + 0.0722 * chan[2];
}

function contrastRatio(fgHex, bgHex) {
  const l1 = relativeLuminance(fgHex);
  const l2 = relativeLuminance(bgHex);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return Number(((lighter + 0.05) / (darker + 0.05)).toFixed(2));
}

function inferRoleFromNode(node) {
  if (node.type === "TEXT") {
    const size = Number(node.fontSize) || 13;
    const weight = String(node.fontWeight || "regular").toLowerCase();
    const isBold = weight.includes("bold") || Number(weight) >= 600;
    const text = (node.characters || "").trim();
    if (node.hyperlink && node.hyperlink.value) return "Link";
    if (/^[-•*]\s+/.test(text) && text.includes("\n")) return "List";
    if (size >= 28) return "H1";
    if (size >= 20 && isBold) return "H2";
    if (size >= 16 && isBold) return "H3";
    return "P";
  }
  if (node.hasImageFill || node.type === "VECTOR" || node.type === "BOOLEAN_OPERATION") {
    return node.isDecorative ? "Artifact" : "Figure";
  }
  return "Artifact";
}

function parseSavedPluginData(rawJson) {
  if (!rawJson) return null;
  try {
    const parsed = JSON.parse(rawJson);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // Ignore corrupted legacy metadata
  }
  return null;
}

/**
 * Merge newly inferred properties with persistent `node.setPluginData` metadata.
 * Strict Edge-Case #4 Invariant: ANY field listed in `userOverriddenFields` is NEVER clobbered on re-scan!
 */
function mergeNodeMetadata(node, savedMeta, autoReadingOrder, geometry = null) {
  const inferredRole = inferRoleFromNode(node);
  const overrides = new Set(Array.isArray(savedMeta?.userOverriddenFields) ? savedMeta.userOverriddenFields : []);

  const role = overrides.has("role") && VALID_ROLES.includes(savedMeta?.role) ? savedMeta.role : inferredRole;
  const alt = overrides.has("alt") ? String(savedMeta?.alt || "") : String(savedMeta?.alt || "");
  const readingOrder =
    overrides.has("readingOrder") && Number.isInteger(savedMeta?.readingOrder)
      ? savedMeta.readingOrder
      : autoReadingOrder;

  const geom = geometry || {
    x: round2(Number(node.x) || 0),
    y: round2(Number(node.y) || 0),
    width: Math.max(0, round2(Number(node.width) || 0)),
    height: Math.max(0, round2(Number(node.height) || 0)),
  };

  const merged = {
    id: node.id,
    name: node.name || node.id,
    type: node.type,
    role,
    alt,
    readingOrder,
    x: geom.x,
    y: geom.y,
    width: geom.width,
    height: geom.height,
    text: node.type === "TEXT" ? String(node.characters || "") : "",
    fontSize: Number(node.fontSize) || 13,
    fontWeight: String(node.fontWeight || "regular"),
    fontFamily: node.type === "TEXT" ? String(node.fontFamily || "") : "",
    color: node.fillHex || "#0F172A",
    url: node.hyperlink?.value || "",
    headers: node.headers || undefined,
    rows: node.rows || undefined,
    visible: node.visible !== false,
    userOverriddenFields: Array.from(overrides),
  };
  if (node.imageBase64) {
    merged.imageBase64 = String(node.imageBase64);
  }
  return merged;
}

/**
 * Recursively walk a Frame / Slide tree (`N >= 3` levels: Frame -> Instance -> Group -> Text/Figure).
 * - Completely ignores `__TagFrame_ReadingOrder_Overlay__` so visual badges never pollute PDF/UA tags.
 * - Computes frame-relative `(x, y, width, height)` via `absoluteBoundingBox` relative to parent frame
 *   (falling back cleanly to local `node.x`/`node.y` offsets when absent).
 * - Respects explicit `Artifact` ancestors (children under an `Artifact` container do NOT leak duplicate tags).
 * - Collects hidden nodes (`visible === false`) into `skippedDeletedNodes`.
 * - Detects previously persisted node IDs that were deleted from Figma (`previousTrackedIds`).
 */
function extractAccessibleFrame(frameNode, previousTrackedIds = []) {
  const bgHex = frameNode.backgroundColor || "#FFFFFF";
  const frameBox = hasValidBoundingBox(frameNode.absoluteBoundingBox)
    ? {
        x: Number(frameNode.absoluteBoundingBox.x),
        y: Number(frameNode.absoluteBoundingBox.y),
        width: Number.isFinite(Number(frameNode.absoluteBoundingBox.width))
          ? Number(frameNode.absoluteBoundingBox.width)
          : Number(frameNode.width) || 960,
        height: Number.isFinite(Number(frameNode.absoluteBoundingBox.height))
          ? Number(frameNode.absoluteBoundingBox.height)
          : Number(frameNode.height) || 540,
      }
    : null;

  const collected = [];
  const skippedDeletedNodes = [];
  const liveNodeIds = new Set();

  function sortChildrenVisually(children, parentOffsetX, parentOffsetY) {
    return [...children]
      .filter((c) => c && c.name !== OVERLAY_GROUP_NAME)
      .sort((a, b) => {
        const ga = computeRelativeGeometry(a, frameBox, parentOffsetX, parentOffsetY);
        const gb = computeRelativeGeometry(b, frameBox, parentOffsetX, parentOffsetY);
        if (Math.abs(ga.y - gb.y) > 8) return ga.y - gb.y;
        return ga.x - gb.x;
      });
  }

  function walk(node, ancestorIsArtifact, depth, offsetX, offsetY) {
    if (!node || node.name === OVERLAY_GROUP_NAME) {
      return;
    }

    liveNodeIds.add(node.id);
    if (node.visible === false) {
      skippedDeletedNodes.push({ id: node.id, name: node.name || node.id, reason: "HIDDEN_IN_FIGMA" });
      return;
    }

    const geom = computeRelativeGeometry(node, frameBox, offsetX, offsetY);
    const saved = parseSavedPluginData(node.pluginData);
    const nodeExplicitArtifact =
      saved &&
      Array.isArray(saved.userOverriddenFields) &&
      saved.userOverriddenFields.includes("role") &&
      saved.role === "Artifact";

    if (ancestorIsArtifact) {
      // Ancestor was explicitly marked decorative Artifact -> never duplicate descendant text into tag tree
      return;
    }

    if (nodeExplicitArtifact) {
      collected.push(mergeNodeMetadata(node, saved, collected.length, geom));
      return; // Stop descending into decorative container
    }

    const isLeafSemantic =
      node.type === "TEXT" ||
      node.hasImageFill ||
      (saved && saved.role === "Table") ||
      (saved && saved.role === "Figure");

    if (isLeafSemantic) {
      collected.push(mergeNodeMetadata(node, saved, collected.length, geom));
      return;
    }

    if (Array.isArray(node.children)) {
      const nextOffsetX = offsetX + (Number(node.x) || 0);
      const nextOffsetY = offsetY + (Number(node.y) || 0);
      const sortedChildren = sortChildrenVisually(node.children, nextOffsetX, nextOffsetY);
      for (const child of sortedChildren) {
        walk(child, false, depth + 1, nextOffsetX, nextOffsetY);
      }
    }
  }

  if (Array.isArray(frameNode.children)) {
    const sorted = sortChildrenVisually(frameNode.children, 0, 0);
    for (const child of sorted) {
      walk(child, false, 1, 0, 0);
    }
  }

  // Flag any previously saved tracked node IDs that were deleted from Figma
  for (const prevId of previousTrackedIds) {
    if (!liveNodeIds.has(prevId)) {
      skippedDeletedNodes.push({ id: prevId, name: prevId, reason: "DELETED_IN_FIGMA" });
    }
  }

  // Final stable sort by readingOrder
  collected.sort((a, b) => a.readingOrder - b.readingOrder);

  return {
    id: frameNode.id,
    name: frameNode.name || "Untitled Frame",
    width: Math.round((frameBox ? frameBox.width : Number(frameNode.width)) || 960),
    height: Math.round((frameBox ? frameBox.height : Number(frameNode.height)) || 540),
    backgroundColor: bgHex,
    nodes: collected,
    skippedDeletedNodes,
  };
}

/**
 * Run complete Dry-Run WCAG / ISO 14289-1 Preflight before exporting to /api/compile.
 */
function runDryRunPreflight(scene) {
  const errors = [];
  const warnings = [];
  const headingSeq = [];
  const allSkipped = [];

  if (!scene.title || !String(scene.title).trim()) {
    errors.push({ code: "MISSING_TITLE", message: "Document title is empty (required for ISO 14289-1 DisplayDocTitle)." });
  }
  if (!scene.lang || !/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})?$/.test(String(scene.lang).trim())) {
    errors.push({ code: "INVALID_LANG", message: "Valid document language tag (e.g. en-US, de-DE) is required." });
  }

  const frames = scene.frames || [];
  if (frames.length === 0) {
    errors.push({ code: "NO_FRAMES", message: "Select at least one Frame or Figma Slide to export." });
  }

  for (const frame of frames) {
    if (Array.isArray(frame.skippedDeletedNodes)) {
      allSkipped.push(...frame.skippedDeletedNodes);
    }
    const visibleSemantic = (frame.nodes || []).filter((n) => n.visible !== false && n.role !== "Artifact");
    if (visibleSemantic.length === 0) {
      warnings.push({ code: "EMPTY_FRAME", frameId: frame.id, message: `Frame "${frame.name}" contains 0 semantic text/figure nodes.` });
    }

    for (const node of frame.nodes || []) {
      if (node.visible === false || node.role === "Artifact") continue;

      if (/^H[1-6]$/.test(node.role)) {
        headingSeq.push({ level: Number(node.role[1]), role: node.role, nodeId: node.id });
      }
      if (node.role === "Figure" && (!node.alt || !String(node.alt).trim())) {
        errors.push({ code: "MISSING_ALT", nodeId: node.id, message: `Figure "${node.name}" is missing required Alt text.` });
      }
      if (node.type === "TEXT" && node.text && node.text.trim()) {
        const ratio = contrastRatio(node.color || "#0F172A", frame.backgroundColor || "#FFFFFF");
        const isBold = String(node.fontWeight || "").toLowerCase().includes("bold") || Number(node.fontWeight) >= 600;
        const isLarge = Number(node.fontSize) >= 18 || (Number(node.fontSize) >= 14 && isBold);
        const minRatio = isLarge ? 3.0 : 4.5;
        if (ratio < minRatio) {
          warnings.push({
            code: "LOW_CONTRAST",
            nodeId: node.id,
            ratio,
            required: minRatio,
            message: `Text "${node.name}" contrast ${ratio}:1 is below WCAG AA (${minRatio}:1).`,
          });
        }
      }
    }
  }

  for (let i = 1; i < headingSeq.length; i++) {
    if (headingSeq[i].level > headingSeq[i - 1].level + 1) {
      errors.push({
        code: "SKIPPED_HEADING",
        nodeId: headingSeq[i].nodeId,
        message: `Heading level skipped: ${headingSeq[i - 1].role} -> ${headingSeq[i].role} (violates ISO 14289-1).`,
      });
    }
  }

  return {
    canExport: errors.length === 0,
    errors,
    warnings,
    headingSequence: headingSeq.map((h) => h.role),
    skippedDeletedNodes: allSkipped,
  };
}

/**
 * TagFrame PDF/UA — Figma Design & Figma Slides Sandbox Controller (`dist/code.js` build entry).
 * Reads selected frames/slides, computes frame-relative geometry via absoluteBoundingBox,
 * persists semantic tags via `node.setPluginData("tagframe_v1", ...)` and settings via `figma.clientStorage`,
 * draws/removes the non-destructive `__TagFrame_ReadingOrder_Overlay__` group,
 * exports 2x Figure PNGs safely in RAM, and communicates with `src/ui.html`.
 */


const PAGE_TRACKED_KEY = "tagframe_tracked_ids_v1";
const SETTINGS_STORAGE_KEY = "tagframe_settings_v1";
const MAX_FIGURE_PNG_BYTES = 8 * 1024 * 1024;

function firstSolidHex(fills, fallback) {
  if (!Array.isArray(fills)) return fallback;
  const solid = fills.find((f) => f && f.type === "SOLID" && f.visible !== false && f.color);
  return solid ? rgb01ToHex(solid.color.r, solid.color.g, solid.color.b) : fallback;
}

function hasImageFill(fills) {
  return Array.isArray(fills) && fills.some((f) => f && f.type === "IMAGE" && f.visible !== false);
}

function encodeBytesToBase64(bytes) {
  if (typeof figma !== "undefined" && typeof figma.base64Encode === "function") {
    return figma.base64Encode(bytes);
  }
  return uint8ArrayToBase64(bytes);
}

function readBoundingBox(node) {
  const box = node.absoluteBoundingBox;
  if (box && typeof box.x === "number" && typeof box.y === "number") {
    return {
      x: box.x,
      y: box.y,
      width: typeof box.width === "number" ? box.width : typeof node.width === "number" ? node.width : 0,
      height: typeof box.height === "number" ? box.height : typeof node.height === "number" ? node.height : 0,
    };
  }
  return null;
}

function snapshotFigmaNode(node) {
  const snap = {
    id: node.id,
    name: node.name || node.id,
    type: node.type,
    visible: node.visible !== false,
    x: typeof node.x === "number" ? node.x : 0,
    y: typeof node.y === "number" ? node.y : 0,
    width: typeof node.width === "number" ? node.width : 0,
    height: typeof node.height === "number" ? node.height : 0,
    absoluteBoundingBox: readBoundingBox(node),
    pluginData: typeof node.getPluginData === "function" ? node.getPluginData(PLUGIN_DATA_KEY) : "",
    backgroundColor: firstSolidHex(node.fills, "#FFFFFF"),
    fillHex: firstSolidHex(node.fills, "#0F172A"),
    hasImageFill: hasImageFill(node.fills),
  };

  if (node.type === "TEXT") {
    snap.characters = node.characters || "";
    snap.fontSize = typeof node.fontSize === "number" ? node.fontSize : 13;
    const hasFontObj = typeof node.fontName === "object" && node.fontName !== null;
    snap.fontWeight = hasFontObj && node.fontName.style ? String(node.fontName.style) : "Regular";
    snap.fontFamily = hasFontObj && node.fontName.family ? String(node.fontName.family) : "";

    if ((!snap.fontFamily || typeof node.fontSize !== "number") && snap.characters.length > 0) {
      if (!snap.fontFamily && typeof node.getRangeFontName === "function") {
        try {
          const rangeFont = node.getRangeFontName(0, 1);
          if (rangeFont && typeof rangeFont === "object") {
            if (rangeFont.family) snap.fontFamily = String(rangeFont.family);
            if (rangeFont.style) snap.fontWeight = String(rangeFont.style);
          }
        } catch {
          // Mixed or inaccessible range font
        }
      }
      if (typeof node.fontSize !== "number" && typeof node.getRangeFontSize === "function") {
        try {
          const rangeSize = node.getRangeFontSize(0, 1);
          if (typeof rangeSize === "number") snap.fontSize = rangeSize;
        } catch {
          // Mixed or inaccessible range size
        }
      }
    }

    snap.hyperlink = node.hyperlink && typeof node.hyperlink === "object" ? node.hyperlink : null;
  }

  if ("children" in node && Array.isArray(node.children)) {
    snap.children = node.children
      .filter((child) => child && child.name !== OVERLAY_GROUP_NAME)
      .map(snapshotFigmaNode);
  }
  return snap;
}

function collectTargetFrames() {
  const sel = figma.currentPage.selection || [];
  const validTypes = new Set(["FRAME", "SLIDE", "COMPONENT", "SECTION"]);
  const picked = sel.filter((n) => validTypes.has(n.type) && n.name !== OVERLAY_GROUP_NAME);
  if (picked.length > 0) return picked;
  return (figma.currentPage.children || [])
    .filter((n) => validTypes.has(n.type) && n.name !== OVERLAY_GROUP_NAME)
    .slice(0, 20);
}

function hasActiveOverlay(targets) {
  for (const frame of targets) {
    if ("children" in frame && Array.isArray(frame.children)) {
      if (frame.children.some((c) => c && c.name === OVERLAY_GROUP_NAME)) return true;
    }
  }
  return (figma.currentPage.children || []).some((c) => c && c.name === OVERLAY_GROUP_NAME);
}

function removeExistingOverlays(targets) {
  let removed = 0;
  const containers = [...targets, figma.currentPage];
  for (const container of containers) {
    if (!container || !("children" in container) || !Array.isArray(container.children)) continue;
    const matches = container.children.filter((c) => c && c.name === OVERLAY_GROUP_NAME);
    for (const overlay of matches) {
      try {
        overlay.locked = false;
        overlay.remove();
        removed++;
      } catch {
        // Ignore read-only / detached overlay node
      }
    }
  }
  return removed;
}

async function loadOverlayFont() {
  const candidates = [
    { family: "Inter", style: "Bold" },
    { family: "Roboto", style: "Bold" },
    { family: "Arial", style: "Bold" },
    { family: "Inter", style: "Regular" },
  ];
  for (const font of candidates) {
    try {
      await figma.loadFontAsync(font);
      return font;
    } catch {
      // Try next available system/Figma font
    }
  }
  return null;
}

async function toggleReadingOrderOverlay() {
  const targets = collectTargetFrames();
  if (targets.length === 0) {
    return { active: false, badgeCount: 0, message: "Select a Frame or Slide first to preview reading order." };
  }

  if (hasActiveOverlay(targets)) {
    removeExistingOverlays(targets);
    return { active: false, badgeCount: 0, message: "Reading order overlay removed." };
  }

  const font = await loadOverlayFont();
  let totalBadges = 0;
  let overlayErrors = 0;

  for (const frame of targets) {
    if (!("appendChild" in frame)) continue;
    try {
      const snap = snapshotFigmaNode(frame);
      const extracted = extractAccessibleFrame(snap, []);
      const semanticNodes = extracted.nodes.filter((n) => n.visible !== false && n.role !== "Artifact");
      if (semanticNodes.length === 0) continue;

      const createdBadges = [];
      for (let i = 0; i < semanticNodes.length; i++) {
        const item = semanticNodes[i];
        const badge = figma.createFrame();
        badge.name = `Badge #${i + 1} (${item.role})`;
        badge.cornerRadius = 10;
        badge.fills = [{ type: "SOLID", color: { r: 15 / 255, g: 118 / 255, b: 110 / 255 } }];
        badge.strokes = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
        badge.strokeWeight = 1.5;
        badge.clipsContent = false;

        const labelText = `#${i + 1} ${item.role}`;
        const badgeW = Math.max(44, Math.min(96, labelText.length * 7 + 14));
        const badgeH = 20;
        badge.resize(badgeW, badgeH);

        if (font && typeof figma.createText === "function") {
          try {
            const txt = figma.createText();
            txt.fontName = font;
            txt.fontSize = 10;
            txt.characters = labelText;
            txt.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
            txt.x = 6;
            txt.y = 4;
            badge.appendChild(txt);
          } catch {
            // Keep colored pill badge even if text creation fails
          }
        }

        const isAutoLayout = frame.layoutMode && frame.layoutMode !== "NONE";
        const bx = Math.max(0, Math.min(Math.max(0, extracted.width - badgeW), Math.round(item.x)));
        const by = Math.max(0, Math.min(Math.max(0, extracted.height - badgeH), Math.round(item.y)));

        if (isAutoLayout && snap.absoluteBoundingBox) {
          // Place on page using absolute coordinates so Auto Layout frames are never reflowed
          badge.x = Math.round(snap.absoluteBoundingBox.x) + bx;
          badge.y = Math.round(snap.absoluteBoundingBox.y) + by;
          figma.currentPage.appendChild(badge);
        } else {
          frame.appendChild(badge);
          if (isAutoLayout) {
            try {
              badge.layoutPositioning = "ABSOLUTE";
            } catch {
              // Ignore if layoutPositioning is unsupported
            }
          }
          badge.x = bx;
          badge.y = by;
        }
        createdBadges.push(badge);
        totalBadges++;
      }

      if (createdBadges.length > 0) {
        const isAutoLayout = frame.layoutMode && frame.layoutMode !== "NONE";
        const groupParent = isAutoLayout && snap.absoluteBoundingBox ? figma.currentPage : frame;
        if (typeof figma.group === "function") {
          const group = figma.group(createdBadges, groupParent);
          group.name = OVERLAY_GROUP_NAME;
          if (isAutoLayout && groupParent === frame) {
            try {
              group.layoutPositioning = "ABSOLUTE";
            } catch {
              // Ignore if layoutPositioning is unsupported on group
            }
          }
          group.locked = true;
        } else {
          // Fallback wrapper frame when figma.group is unavailable
          const wrapper = figma.createFrame();
          wrapper.name = OVERLAY_GROUP_NAME;
          wrapper.fills = [];
          wrapper.clipsContent = false;
          wrapper.x = groupParent === figma.currentPage && snap.absoluteBoundingBox ? Math.round(snap.absoluteBoundingBox.x) : 0;
          wrapper.y = groupParent === figma.currentPage && snap.absoluteBoundingBox ? Math.round(snap.absoluteBoundingBox.y) : 0;
          wrapper.resize(Math.max(1, extracted.width), Math.max(1, extracted.height));
          for (const b of createdBadges) wrapper.appendChild(b);
          groupParent.appendChild(wrapper);
          wrapper.locked = true;
        }
      }
    } catch {
      overlayErrors++;
    }
  }

  if (totalBadges === 0) {
    return {
      active: false,
      badgeCount: 0,
      message: overlayErrors > 0 ? "Could not draw overlay on read-only/restricted frame." : "No visible semantic nodes to badge.",
    };
  }

  return {
    active: true,
    badgeCount: totalBadges,
    message: `Reading order overlay active (${totalBadges} badge(s) — excluded from PDF/UA export).`,
  };
}

let currentTitle = figma.root.name || "Accessible Document";
let currentLang = "en-US";
let currentSettings = {
  apiBaseUrl: DEFAULT_API_BASE_URL,
  layoutMode: "positioned",
};

async function loadPersistedSettings() {
  try {
    if (figma.clientStorage && typeof figma.clientStorage.getAsync === "function") {
      const saved = await figma.clientStorage.getAsync(SETTINGS_STORAGE_KEY);
      if (saved && typeof saved === "object") {
        const checkedUrl = normalizeApiBaseUrl(saved.apiBaseUrl, DEFAULT_API_BASE_URL);
        currentSettings = {
          apiBaseUrl: checkedUrl.ok ? checkedUrl.url : DEFAULT_API_BASE_URL,
          layoutMode: VALID_LAYOUT_MODES.includes(saved.layoutMode) ? saved.layoutMode : "positioned",
        };
      }
    }
  } catch {
    // Keep defaults if clientStorage is unavailable
  }
  return currentSettings;
}

async function savePersistedSettings(patch) {
  const nextUrlCheck =
    patch.apiBaseUrl !== undefined
      ? normalizeApiBaseUrl(patch.apiBaseUrl, DEFAULT_API_BASE_URL)
      : { ok: true, url: currentSettings.apiBaseUrl };

  if (!nextUrlCheck.ok) {
    return { ok: false, error: nextUrlCheck.error, settings: currentSettings };
  }

  const nextLayout =
    patch.layoutMode !== undefined && VALID_LAYOUT_MODES.includes(patch.layoutMode)
      ? patch.layoutMode
      : currentSettings.layoutMode;

  currentSettings = {
    apiBaseUrl: nextUrlCheck.url,
    layoutMode: nextLayout,
  };

  try {
    if (figma.clientStorage && typeof figma.clientStorage.setAsync === "function") {
      await figma.clientStorage.setAsync(SETTINGS_STORAGE_KEY, currentSettings);
    }
  } catch {
    // Continue with in-session settings if clientStorage write is blocked
  }
  return { ok: true, settings: currentSettings };
}

function buildCurrentScene(docTitle, docLang, layoutMode) {
  const targets = collectTargetFrames();
  const prevRaw = figma.currentPage.getPluginData(PAGE_TRACKED_KEY);
  const prevTracked = parseSavedPluginData(prevRaw) || {};

  const frames = targets.map((frame) => {
    const snap = snapshotFigmaNode(frame);
    const extracted = extractAccessibleFrame(snap, Array.isArray(prevTracked[frame.id]) ? prevTracked[frame.id] : []);
    prevTracked[frame.id] = extracted.nodes.map((n) => n.id);
    return extracted;
  });

  figma.currentPage.setPluginData(PAGE_TRACKED_KEY, JSON.stringify(prevTracked));

  const scene = {
    title: docTitle || figma.root.name || "Accessible Document",
    author: "TagFrame PDF/UA",
    lang: docLang || "en-US",
    layoutMode: VALID_LAYOUT_MODES.includes(layoutMode) ? layoutMode : currentSettings.layoutMode,
    frames,
  };
  const preflight = runDryRunPreflight(scene);
  return { scene, preflight, overlayActive: hasActiveOverlay(targets) };
}

async function prepareExportScene(msg) {
  if (typeof msg.title === "string") currentTitle = msg.title;
  if (typeof msg.lang === "string") currentLang = msg.lang;
  const layoutMode = VALID_LAYOUT_MODES.includes(msg.layoutMode) ? msg.layoutMode : currentSettings.layoutMode;

  const { scene, preflight } = buildCurrentScene(currentTitle, currentLang, layoutMode);
  let exportedFigures = 0;
  const exportWarnings = [];

  for (const frame of scene.frames) {
    for (const node of frame.nodes) {
      if (node.visible === false || node.role !== "Figure") continue;
      try {
        const figNode = await figma.getNodeByIdAsync(node.id);
        if (!figNode || typeof figNode.exportAsync !== "function") continue;

        let pngBytes = await figNode.exportAsync({
          format: "PNG",
          constraint: { type: "SCALE", value: 2 },
        });
        if (pngBytes && pngBytes.length > MAX_FIGURE_PNG_BYTES) {
          pngBytes = await figNode.exportAsync({
            format: "PNG",
            constraint: { type: "SCALE", value: 1 },
          });
        }
        if (pngBytes && pngBytes.length > 0 && pngBytes.length <= MAX_FIGURE_PNG_BYTES) {
          node.imageBase64 = encodeBytesToBase64(pngBytes);
          exportedFigures++;
        } else if (pngBytes && pngBytes.length > MAX_FIGURE_PNG_BYTES) {
          exportWarnings.push(`Figure "${node.name}" exceeded 8 MB PNG limit; exported with placeholder alt box.`);
        }
      } catch (err) {
        exportWarnings.push(`Could not rasterize Figure "${node.name}": ${err && err.message ? err.message : "export error"}`);
      }
    }
  }

  return {
    mode: msg.mode === "download-json" ? "download-json" : "compile",
    scene,
    preflight,
    exportedFigures,
    exportWarnings,
  };
}

figma.showUI(__html__, { width: 440, height: 700, themeColors: true });

function sendScan() {
  const payload = buildCurrentScene(currentTitle, currentLang, currentSettings.layoutMode);
  figma.ui.postMessage({ type: "SCAN_RESULT", ...payload });
}

figma.ui.onmessage = async (msg) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "INIT") {
    if (typeof msg.title === "string" && msg.title.trim()) currentTitle = msg.title;
    if (typeof msg.lang === "string" && msg.lang.trim()) currentLang = msg.lang;
    const settings = await loadPersistedSettings();
    figma.ui.postMessage({ type: "SETTINGS_LOADED", settings });
    sendScan();
    return;
  }

  if (msg.type === "SAVE_SETTINGS") {
    if (typeof msg.title === "string") currentTitle = msg.title;
    if (typeof msg.lang === "string") currentLang = msg.lang;
    const result = await savePersistedSettings(msg);
    figma.ui.postMessage({
      type: "SETTINGS_LOADED",
      settings: result.settings,
      saved: result.ok,
      error: result.error || "",
    });
    return;
  }

  if (msg.type === "RESCAN") {
    if (typeof msg.title === "string") currentTitle = msg.title;
    if (typeof msg.lang === "string") currentLang = msg.lang;
    if (VALID_LAYOUT_MODES.includes(msg.layoutMode)) {
      currentSettings = { ...currentSettings, layoutMode: msg.layoutMode };
    }
    sendScan();
    return;
  }

  if (msg.type === "TOGGLE_OVERLAY") {
    const status = await toggleReadingOrderOverlay();
    figma.ui.postMessage({ type: "OVERLAY_STATUS", ...status });
    return;
  }

  if (msg.type === "PREPARE_EXPORT") {
    const prepared = await prepareExportScene(msg);
    figma.ui.postMessage({ type: "EXPORT_READY", ...prepared });
    return;
  }

  if (msg.type === "UPDATE_NODE_META") {
    const node = await figma.getNodeByIdAsync(msg.nodeId);
    if (node && typeof node.setPluginData === "function") {
      const existing = parseSavedPluginData(node.getPluginData(PLUGIN_DATA_KEY)) || {};
      const overrides = new Set(Array.isArray(existing.userOverriddenFields) ? existing.userOverriddenFields : []);
      const updated = { ...existing };
      if (msg.role !== undefined) {
        updated.role = msg.role;
        overrides.add("role");
      }
      if (msg.alt !== undefined) {
        updated.alt = String(msg.alt);
        overrides.add("alt");
      }
      if (msg.readingOrder !== undefined) {
        updated.readingOrder = Number(msg.readingOrder);
        overrides.add("readingOrder");
      }
      updated.userOverriddenFields = Array.from(overrides);
      node.setPluginData(PLUGIN_DATA_KEY, JSON.stringify(updated));
    }
    sendScan();
  }
};

(async () => {
  const settings = await loadPersistedSettings();
  figma.ui.postMessage({ type: "SETTINGS_LOADED", settings });
  sendScan();
})();

})();

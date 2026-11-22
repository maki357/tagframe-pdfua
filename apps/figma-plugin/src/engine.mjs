/**
 * TagFrame PDF/UA — Pure Deterministic Scene-Graph, Tag-Persistence & WCAG Dry-Run Preflight Engine.
 * Zero Figma runtime globals so every state-machine invariant can be unit-tested in Node.js.
 */

export const PLUGIN_DATA_KEY = "tagframe_v1";
export const OVERLAY_GROUP_NAME = "__TagFrame_ReadingOrder_Overlay__";
export const DEFAULT_API_BASE_URL = "http://127.0.0.1:8000";
export const VALID_ROLES = ["H1", "H2", "H3", "H4", "H5", "H6", "P", "List", "Link", "Table", "Figure", "Artifact"];
export const VALID_LAYOUT_MODES = ["positioned", "flow"];
export const MAX_CUSTOM_FONTS = 5;
export const MAX_CUSTOM_FONT_BYTES = 5 * 1024 * 1024;

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Strict HTML entity escaping helper for safe text rendering (never raw HTML injection). */
export function escapeHtml(value) {
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
export function normalizeApiBaseUrl(rawUrl, fallback = DEFAULT_API_BASE_URL) {
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
export function sanitizeCustomFontFilename(rawName) {
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
export function uint8ArrayToBase64(bytes) {
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

export function rgb01ToHex(r, g, b) {
  const clamp = (v) => Math.max(0, Math.min(255, Math.round((Number(v) || 0) * 255)));
  return (
    "#" +
    [clamp(r), clamp(g), clamp(b)]
      .map((n) => n.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()
  );
}

export function hexToRgb255(hex) {
  const m = String(hex || "").trim().match(/^#([0-9a-fA-F]{6})$/);
  if (!m) return { r: 15, g: 23, b: 42 };
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** Exact WCAG 2.1 relative luminance & contrast ratio */
export function relativeLuminance(hex) {
  const { r, g, b } = hexToRgb255(hex);
  const chan = [r, g, b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * chan[0] + 0.7152 * chan[1] + 0.0722 * chan[2];
}

export function contrastRatio(fgHex, bgHex) {
  const l1 = relativeLuminance(fgHex);
  const l2 = relativeLuminance(bgHex);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return Number(((lighter + 0.05) / (darker + 0.05)).toFixed(2));
}

export function inferRoleFromNode(node) {
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

export function parseSavedPluginData(rawJson) {
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
export function mergeNodeMetadata(node, savedMeta, autoReadingOrder, geometry = null) {
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
export function extractAccessibleFrame(frameNode, previousTrackedIds = []) {
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
export function runDryRunPreflight(scene) {
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

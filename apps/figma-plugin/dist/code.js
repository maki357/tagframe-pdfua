"use strict";
(() => {
/**
 * TagFrame PDF/UA — Pure Deterministic Scene-Graph, Tag-Persistence & WCAG Dry-Run Preflight Engine.
 * Zero Figma runtime globals so every state-machine invariant can be unit-tested in Node.js.
 */

const PLUGIN_DATA_KEY = "tagframe_v1";
const VALID_ROLES = ["H1", "H2", "H3", "H4", "H5", "H6", "P", "List", "Link", "Table", "Figure", "Artifact"];

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
function mergeNodeMetadata(node, savedMeta, autoReadingOrder) {
  const inferredRole = inferRoleFromNode(node);
  const overrides = new Set(Array.isArray(savedMeta?.userOverriddenFields) ? savedMeta.userOverriddenFields : []);

  const role = overrides.has("role") && VALID_ROLES.includes(savedMeta?.role) ? savedMeta.role : inferredRole;
  const alt = overrides.has("alt") ? String(savedMeta?.alt || "") : String(savedMeta?.alt || "");
  const readingOrder =
    overrides.has("readingOrder") && Number.isInteger(savedMeta?.readingOrder)
      ? savedMeta.readingOrder
      : autoReadingOrder;

  return {
    id: node.id,
    name: node.name || node.id,
    type: node.type,
    role,
    alt,
    readingOrder,
    text: node.type === "TEXT" ? String(node.characters || "") : "",
    fontSize: Number(node.fontSize) || 13,
    fontWeight: String(node.fontWeight || "regular"),
    color: node.fillHex || "#0F172A",
    url: node.hyperlink?.value || "",
    headers: node.headers || undefined,
    rows: node.rows || undefined,
    visible: node.visible !== false,
    userOverriddenFields: Array.from(overrides),
  };
}

/**
 * Recursively walk a Frame / Slide tree (`N >= 3` levels: Frame -> Instance -> Group -> Text/Figure).
 * - Respects explicit `Artifact` ancestors (children under an `Artifact` container do NOT leak duplicate tags).
 * - Collects hidden nodes (`visible === false`) into `skippedDeletedNodes`.
 * - Detects previously persisted node IDs that were deleted from Figma (`previousTrackedIds`).
 */
function extractAccessibleFrame(frameNode, previousTrackedIds = []) {
  const bgHex = frameNode.backgroundColor || "#FFFFFF";
  const collected = [];
  const skippedDeletedNodes = [];
  const liveNodeIds = new Set();

  function walk(node, ancestorIsArtifact, depth) {
    liveNodeIds.add(node.id);
    if (node.visible === false) {
      skippedDeletedNodes.push({ id: node.id, name: node.name || node.id, reason: "HIDDEN_IN_FIGMA" });
      return;
    }

    const saved = parseSavedPluginData(node.pluginData);
    const nodeExplicitArtifact =
      saved && Array.isArray(saved.userOverriddenFields) && saved.userOverriddenFields.includes("role") && saved.role === "Artifact";

    if (ancestorIsArtifact) {
      // Ancestor was explicitly marked decorative Artifact -> never duplicate descendant text into tag tree
      return;
    }

    if (nodeExplicitArtifact) {
      collected.push(mergeNodeMetadata(node, saved, collected.length));
      return; // Stop descending into decorative container
    }

    const isLeafSemantic =
      node.type === "TEXT" ||
      node.hasImageFill ||
      (saved && saved.role === "Table") ||
      (saved && saved.role === "Figure");

    if (isLeafSemantic) {
      collected.push(mergeNodeMetadata(node, saved, collected.length));
      return;
    }

    if (Array.isArray(node.children)) {
      // Visual top-to-bottom, left-to-right heuristic before user readingOrder overrides
      const sortedChildren = [...node.children].sort((a, b) => {
        const ay = Number(a.y) || 0;
        const by = Number(b.y) || 0;
        if (Math.abs(ay - by) > 8) return ay - by;
        return (Number(a.x) || 0) - (Number(b.x) || 0);
      });
      for (const child of sortedChildren) {
        walk(child, false, depth + 1);
      }
    }
  }

  if (Array.isArray(frameNode.children)) {
    const sorted = [...frameNode.children].sort((a, b) => {
      const ay = Number(a.y) || 0;
      const by = Number(b.y) || 0;
      if (Math.abs(ay - by) > 8) return ay - by;
      return (Number(a.x) || 0) - (Number(b.x) || 0);
    });
    for (const child of sorted) {
      walk(child, false, 1);
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
    width: Math.round(Number(frameNode.width) || 960),
    height: Math.round(Number(frameNode.height) || 540),
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
 * Reads selected frames/slides, persists semantic tags via `node.setPluginData("tagframe_v1", ...)`,
 * runs WCAG / ISO 14289-1 Dry-Run Preflight, and communicates with `src/ui.html`.
 */


const PAGE_TRACKED_KEY = "tagframe_tracked_ids_v1";

function firstSolidHex(fills, fallback) {
  if (!Array.isArray(fills)) return fallback;
  const solid = fills.find((f) => f && f.type === "SOLID" && f.visible !== false && f.color);
  return solid ? rgb01ToHex(solid.color.r, solid.color.g, solid.color.b) : fallback;
}

function hasImageFill(fills) {
  return Array.isArray(fills) && fills.some((f) => f && f.type === "IMAGE" && f.visible !== false);
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
    pluginData: typeof node.getPluginData === "function" ? node.getPluginData(PLUGIN_DATA_KEY) : "",
    backgroundColor: firstSolidHex(node.fills, "#FFFFFF"),
    fillHex: firstSolidHex(node.fills, "#0F172A"),
    hasImageFill: hasImageFill(node.fills),
  };

  if (node.type === "TEXT") {
    snap.characters = node.characters || "";
    snap.fontSize = typeof node.fontSize === "number" ? node.fontSize : 13;
    snap.fontWeight =
      typeof node.fontName === "object" && node.fontName && node.fontName.style
        ? node.fontName.style
        : "Regular";
    snap.hyperlink = node.hyperlink && typeof node.hyperlink === "object" ? node.hyperlink : null;
  }

  if ("children" in node && Array.isArray(node.children)) {
    snap.children = node.children.map(snapshotFigmaNode);
  }
  return snap;
}

function collectTargetFrames() {
  const sel = figma.currentPage.selection || [];
  const validTypes = new Set(["FRAME", "SLIDE", "COMPONENT", "SECTION"]);
  const picked = sel.filter((n) => validTypes.has(n.type));
  if (picked.length > 0) return picked;
  return (figma.currentPage.children || []).filter((n) => validTypes.has(n.type)).slice(0, 20);
}

function buildCurrentScene(docTitle, docLang) {
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
    frames,
  };
  const preflight = runDryRunPreflight(scene);
  return { scene, preflight };
}

figma.showUI(__html__, { width: 420, height: 640, themeColors: true });

let currentTitle = figma.root.name || "Accessible Document";
let currentLang = "en-US";

function sendScan() {
  const payload = buildCurrentScene(currentTitle, currentLang);
  figma.ui.postMessage({ type: "SCAN_RESULT", ...payload });
}

figma.ui.onmessage = async (msg) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "INIT" || msg.type === "RESCAN") {
    if (msg.title) currentTitle = String(msg.title);
    if (msg.lang) currentLang = String(msg.lang);
    sendScan();
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

sendScan();

})();

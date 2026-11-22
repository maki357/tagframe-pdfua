/**
 * TagFrame PDF/UA — Figma Design & Figma Slides Sandbox Controller (`dist/code.js` build entry).
 * Reads selected frames/slides, persists semantic tags via `node.setPluginData("tagframe_v1", ...)`,
 * runs WCAG / ISO 14289-1 Dry-Run Preflight, and communicates with `src/ui.html`.
 */
import {
  PLUGIN_DATA_KEY,
  extractAccessibleFrame,
  parseSavedPluginData,
  rgb01ToHex,
  runDryRunPreflight,
} from "./engine.mjs";

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

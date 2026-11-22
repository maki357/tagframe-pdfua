/**
 * TagFrame PDF/UA — Figma Design & Figma Slides Sandbox Controller (`dist/code.js` build entry).
 * Reads selected frames/slides, computes frame-relative geometry via absoluteBoundingBox,
 * persists semantic tags via `node.setPluginData("tagframe_v1", ...)` and settings via `figma.clientStorage`,
 * draws/removes the non-destructive `__TagFrame_ReadingOrder_Overlay__` group,
 * exports 2x Figure PNGs safely in RAM, and communicates with `src/ui.html`.
 */
import {
  DEFAULT_API_BASE_URL,
  OVERLAY_GROUP_NAME,
  PLUGIN_DATA_KEY,
  VALID_LAYOUT_MODES,
  extractAccessibleFrame,
  normalizeApiBaseUrl,
  parseSavedPluginData,
  rgb01ToHex,
  runDryRunPreflight,
  uint8ArrayToBase64,
} from "./engine.mjs";

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

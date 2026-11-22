import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import {
  OVERLAY_GROUP_NAME,
  PLUGIN_DATA_KEY,
  escapeHtml,
  extractAccessibleFrame,
  normalizeApiBaseUrl,
  runDryRunPreflight,
  sanitizeCustomFontFilename,
  uint8ArrayToBase64,
} from "../apps/figma-plugin/src/engine.mjs";
import { inspectPdfUa } from "../apps/web/pdfua_inspector.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

function makeValidPngBuffer(width = 8, height = 8, r = 15, g = 118, b = 110) {
  function crc32(buf) {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      crc ^= buf[i];
      for (let j = 0; j < 8; j++) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
    }
    return (crc ^ 0xffffffff) >>> 0;
  }
  function chunk(type, data) {
    const typeBuf = Buffer.from(type, "ascii");
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length, 0);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB color type
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    row[0] = 0; // filter none
    for (let x = 0; x < width; x++) {
      row[1 + x * 3] = r;
      row[2 + x * 3] = g;
      row[3 + x * 3] = b;
    }
    rows.push(row);
  }
  const idat = zlib.deflateSync(Buffer.concat(rows));
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

const SAMPLE_PNG_BASE64 = makeValidPngBuffer(8, 8).toString("base64");

function compileViaPython(scene) {
  const pyCode = `
import json, sys, base64
sys.path.insert(0, r"${path.join(rootDir, "apps", "api")}")
from compiler import compile_figma_scene_to_pdfua1
scene = json.loads(sys.stdin.read())
pdf_bytes, tel = compile_figma_scene_to_pdfua1(scene)
sys.stdout.write(json.dumps({"pdf_b64": base64.b64encode(pdf_bytes).decode("ascii"), "telemetry": tel}))
`;
  const py = spawnSync("python", ["-c", pyCode], { input: JSON.stringify(scene), encoding: "utf8" });
  assert.equal(py.status, 0, `Python compiler failed: ${py.stderr}`);
  return JSON.parse(py.stdout);
}

async function run() {
  let passed = 0;
  async function test(name, fn) {
    await fn();
    passed++;
    console.log(`PASS: ${name}`);
  }

  // Edge Case #4: Partial manual edit preservation across re-scans
  await test("Edge Case #4: Preserves userOverriddenFields (role, alt, readingOrder) after text edit re-scan", async () => {
    const saved = JSON.stringify({
      role: "H2",
      alt: "Quarterly revenue growth chart",
      readingOrder: 9,
      userOverriddenFields: ["role", "alt", "readingOrder"],
    });
    const frame = {
      id: "frame-1",
      name: "Slide 1",
      width: 960,
      height: 540,
      backgroundColor: "#FFFFFF",
      children: [
        {
          id: "node-1",
          name: "Edited Title",
          type: "TEXT",
          characters: "Updated Copy After Client Typo Fix",
          fontSize: 32, // Auto-inference would say H1, but user explicitly overrode to H2!
          fontWeight: "Bold",
          fontFamily: "Inter",
          fillHex: "#0F172A",
          pluginData: saved,
        },
      ],
    };
    const extracted = extractAccessibleFrame(frame);
    assert.equal(extracted.nodes.length, 1);
    assert.equal(extracted.nodes[0].role, "H2");
    assert.equal(extracted.nodes[0].alt, "Quarterly revenue growth chart");
    assert.equal(extracted.nodes[0].readingOrder, 9);
    assert.equal(extracted.nodes[0].text, "Updated Copy After Client Typo Fix");
    assert.equal(extracted.nodes[0].fontFamily, "Inter");
  });

  // Edge Case #5: Deep nesting (N >= 3: Frame -> Instance -> Group -> Text/Figure) in 3 orderings
  await test("Edge Case #5: Deep N>=3 nested components with Artifact suppression across 3 orderings", async () => {
    const makeNested = (order) => {
      const blocks = {
        1: {
          id: "inst-artifact",
          name: "Decorative Bg Instance",
          type: "INSTANCE",
          y: order.indexOf(1) * 100,
          pluginData: JSON.stringify({ role: "Artifact", userOverriddenFields: ["role"] }),
          children: [
            {
              id: "grp-inner",
              type: "GROUP",
              children: [{ id: "txt-secret-bg", type: "TEXT", characters: "WATERMARK", fontSize: 60 }],
            },
          ],
        },
        2: {
          id: "inst-header",
          name: "Header Instance",
          type: "INSTANCE",
          y: order.indexOf(2) * 100,
          children: [
            {
              id: "grp-h",
              type: "GROUP",
              children: [{ id: "txt-h1", name: "Main H1", type: "TEXT", characters: "Annual Report", fontSize: 32, fontWeight: "Bold", fillHex: "#0F172A" }],
            },
          ],
        },
        3: {
          id: "inst-body",
          name: "Body Instance",
          type: "INSTANCE",
          y: order.indexOf(3) * 100,
          children: [
            {
              id: "grp-b",
              type: "GROUP",
              children: [
                {
                  id: "img-chart",
                  name: "Growth Chart",
                  type: "RECTANGLE",
                  hasImageFill: true,
                  pluginData: JSON.stringify({ role: "Figure", alt: "Bar chart showing 42% YoY growth", userOverriddenFields: ["role", "alt"] }),
                },
              ],
            },
          ],
        },
      };
      return { id: "f-deep", name: "Deep Frame", width: 960, height: 540, backgroundColor: "#FFFFFF", children: order.map((k) => blocks[k]) };
    };

    for (const ordering of [
      [1, 2, 3],
      [2, 1, 3],
      [3, 2, 1],
    ]) {
      const ex = extractAccessibleFrame(makeNested(ordering));
      // Watermark text inside Artifact instance MUST NOT leak into extracted nodes!
      assert.equal(ex.nodes.some((n) => n.id === "txt-secret-bg"), false);
      assert.equal(ex.nodes.length, 3);
      assert.equal(ex.nodes.filter((n) => n.role === "Artifact").length, 1);
      assert.equal(ex.nodes.filter((n) => n.role === "H1").length, 1);
      assert.equal(ex.nodes.filter((n) => n.role === "Figure").length, 1);
    }
  });

  // Edge Case #6: Deleted & Hidden nodes cleanly reported in skippedDeletedNodes
  await test("Edge Case #6: Hidden & deleted Figma nodes reported in skippedDeletedNodes without crash", async () => {
    const frame = {
      id: "f-del",
      name: "Slide With Removals",
      width: 960,
      height: 540,
      backgroundColor: "#FFFFFF",
      children: [
        { id: "n-live", name: "Title", type: "TEXT", characters: "Live Heading", fontSize: 30, fontWeight: "Bold", fillHex: "#0F172A" },
        { id: "n-hidden", name: "Draft Note", type: "TEXT", characters: "Hidden", visible: false, fontSize: 14 },
      ],
    };
    const ex = extractAccessibleFrame(frame, ["n-live", "n-deleted-by-designer"]);
    assert.equal(ex.nodes.length, 1);
    assert.equal(ex.skippedDeletedNodes.length, 2);
    assert.ok(ex.skippedDeletedNodes.some((s) => s.id === "n-hidden" && s.reason === "HIDDEN_IN_FIGMA"));
    assert.ok(ex.skippedDeletedNodes.some((s) => s.id === "n-deleted-by-designer" && s.reason === "DELETED_IN_FIGMA"));
  });

  // NEW: Frame-relative geometry extraction from nested absoluteBoundingBox + fontFamily
  await test("Geometry: Computes frame-relative (x, y, width, height) from nested absoluteBoundingBox + fontFamily", async () => {
    const frame = {
      id: "f-abs",
      name: "Canvas Offset Slide",
      x: 1200,
      y: -400,
      width: 960,
      height: 540,
      absoluteBoundingBox: { x: 1200, y: -400, width: 960, height: 540 },
      backgroundColor: "#FFFFFF",
      children: [
        {
          id: "inst-col-right",
          name: "Right Column Instance",
          type: "INSTANCE",
          x: 500,
          y: 120,
          absoluteBoundingBox: { x: 1700, y: -280, width: 400, height: 320 },
          children: [
            {
              id: "grp-nested",
              name: "Inner Group",
              type: "GROUP",
              x: 24,
              y: 16,
              absoluteBoundingBox: { x: 1724, y: -264, width: 352, height: 200 },
              children: [
                {
                  id: "txt-right",
                  name: "Right Column Copy",
                  type: "TEXT",
                  x: 0,
                  y: 0,
                  width: 352,
                  height: 64,
                  absoluteBoundingBox: { x: 1724.456, y: -263.75, width: 352.2, height: 64.5 },
                  characters: "Second column body copy",
                  fontSize: 14,
                  fontWeight: "Regular",
                  fontFamily: "Plus Jakarta Sans",
                  fillHex: "#0F172A",
                },
              ],
            },
          ],
        },
        {
          id: "txt-left",
          name: "Left Heading",
          type: "TEXT",
          x: 48,
          y: 36,
          width: 420,
          height: 44,
          absoluteBoundingBox: { x: 1248, y: -364, width: 420, height: 44 },
          characters: "Quarterly Briefing",
          fontSize: 30,
          fontWeight: "Bold",
          fontFamily: "Inter",
          fillHex: "#0F172A",
        },
      ],
    };

    const ex = extractAccessibleFrame(frame);
    assert.equal(ex.nodes.length, 2);
    // Visual sort places y=36 before y=136.25
    assert.equal(ex.nodes[0].id, "txt-left");
    assert.equal(ex.nodes[0].x, 48);
    assert.equal(ex.nodes[0].y, 36);
    assert.equal(ex.nodes[0].width, 420);
    assert.equal(ex.nodes[0].height, 44);
    assert.equal(ex.nodes[0].fontFamily, "Inter");

    assert.equal(ex.nodes[1].id, "txt-right");
    assert.equal(ex.nodes[1].x, 524.46);
    assert.equal(ex.nodes[1].y, 136.25);
    assert.equal(ex.nodes[1].width, 352.2);
    assert.equal(ex.nodes[1].height, 64.5);
    assert.equal(ex.nodes[1].fontFamily, "Plus Jakarta Sans");
  });

  // NEW: __TagFrame_ReadingOrder_Overlay__ exclusion from extracted nodes & skippedDeletedNodes
  await test("Overlay Exclusion: __TagFrame_ReadingOrder_Overlay__ and all badge children never pollute extracted tree", async () => {
    const frame = {
      id: "f-ov",
      name: "Annotated Slide",
      width: 960,
      height: 540,
      backgroundColor: "#FFFFFF",
      children: [
        {
          id: "n-h1",
          name: "Slide Title",
          type: "TEXT",
          x: 40,
          y: 40,
          width: 400,
          height: 40,
          characters: "Real Heading",
          fontSize: 30,
          fontWeight: "Bold",
          fillHex: "#0F172A",
        },
        {
          id: "ov-group",
          name: OVERLAY_GROUP_NAME,
          type: "GROUP",
          visible: true,
          locked: true,
          children: [
            {
              id: "badge-1",
              name: "Badge #1 (H1)",
              type: "FRAME",
              children: [
                {
                  id: "badge-txt-1",
                  name: "Badge Text",
                  type: "TEXT",
                  characters: "#1 H1",
                  fontSize: 10,
                  fontWeight: "Bold",
                  fillHex: "#FFFFFF",
                },
              ],
            },
          ],
        },
      ],
    };

    const ex = extractAccessibleFrame(frame);
    assert.equal(ex.nodes.length, 1);
    assert.equal(ex.nodes[0].id, "n-h1");
    assert.equal(ex.nodes.some((n) => n.name === OVERLAY_GROUP_NAME || n.id.startsWith("badge-")), false);
    assert.equal(ex.skippedDeletedNodes.length, 0);
  });

  // NEW: XSS defense & URL/font sanitization + zero innerHTML sinks in src/ui.html
  await test("Security & XSS: Escapes malicious node/alt payloads, blocks unsafe URLs/fonts, and has zero innerHTML sinks in ui.html", async () => {
    const xssPayload = `"><img src=x onerror="alert(1)"><script>evil('x')</script>`;
    const escaped = escapeHtml(xssPayload);
    assert.equal(escaped.includes("<"), false);
    assert.equal(escaped.includes(">"), false);
    assert.equal(escaped.includes('"'), false);
    assert.equal(escaped.includes("'"), false);
    assert.ok(escaped.includes("&lt;img"));
    assert.ok(escaped.includes("&quot;"));

    // Verify src/ui.html has ZERO innerHTML / outerHTML / insertAdjacentHTML / document.write / dead Railway URL
    const uiHtmlPath = path.join(rootDir, "apps", "figma-plugin", "src", "ui.html");
    const uiHtml = fs.readFileSync(uiHtmlPath, "utf8");
    assert.equal(/\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|document\.write/i.test(uiHtml), false, "Unsafe HTML sink found in ui.html!");
    assert.equal(/railway\.app/i.test(uiHtml), false, "Dead railway.app URL still present in ui.html!");

    // Verify manifest.json has no dead Railway URL and parses cleanly
    const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, "apps", "figma-plugin", "manifest.json"), "utf8"));
    assert.equal(JSON.stringify(manifest).includes("railway.app"), false);
    assert.ok(manifest.networkAccess.devAllowedDomains.includes("http://127.0.0.1:8000"));

    // Verify inline ui.html script escapeHtml + DOM rendering never raw-injects XSS payloads
    const scriptMatch = uiHtml.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(scriptMatch, "Missing inline <script> in ui.html");
    const syntaxCheck = spawnSync(process.execPath, ["--check"], { input: scriptMatch[1], encoding: "utf8" });
    assert.equal(syntaxCheck.status, 0, `ui.html inline script syntax error: ${syntaxCheck.stderr}`);

    // Execute ui.html render() inside a lightweight mock DOM with XSS payloads in frame name, node name, alt, and error message
    const createdTexts = [];
    const createdValues = [];
    const makeEl = (tag) => {
      const el = {
        tagName: tag.toUpperCase(),
        className: "",
        style: {},
        children: [],
        firstChild: null,
        _text: "",
        _value: "",
        get textContent() { return this._text; },
        set textContent(v) { this._text = String(v); createdTexts.push(this._text); },
        get value() { return this._value; },
        set value(v) { this._value = String(v); createdValues.push(this._value); },
        appendChild(child) {
          this.children.push(child);
          if (!this.firstChild) this.firstChild = child;
          return child;
        },
        removeChild(child) {
          const i = this.children.indexOf(child);
          if (i >= 0) this.children.splice(i, 1);
          this.firstChild = this.children[0] || null;
          return child;
        },
        remove() {},
        addEventListener() {},
      };
      return el;
    };
    const elementsById = {
      "doc-title": makeEl("input"),
      "doc-lang": makeEl("input"),
      "layout-mode": makeEl("select"),
      "api-base-url": makeEl("input"),
      "custom-fonts-input": makeEl("input"),
      "custom-fonts-list": makeEl("div"),
      "rescan-btn": makeEl("button"),
      "overlay-btn": makeEl("button"),
      "download-json-btn": makeEl("button"),
      "export-btn": makeEl("button"),
      "preflight-box": makeEl("div"),
      "nodes-container": makeEl("div"),
      status: makeEl("div"),
    };
    const sandbox = {
      parent: { postMessage() {} },
      window: {},
      document: {
        activeElement: null,
        body: makeEl("body"),
        getElementById: (id) => elementsById[id] || makeEl("div"),
        createElement: makeEl,
        createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
      },
      URL,
      Blob,
      Uint8Array,
      setTimeout,
    };
    vm.runInNewContext(scriptMatch[1], sandbox);
    assert.equal(sandbox.escapeHtml(xssPayload), escaped);

    const xssScene = {
      title: xssPayload,
      lang: "en-US",
      frames: [
        {
          id: "f-xss",
          name: `Frame ${xssPayload}`,
          width: 960,
          height: 540,
          backgroundColor: "#FFFFFF",
          nodes: [
            {
              id: "n-xss-fig",
              name: `Fig ${xssPayload}`,
              type: "RECTANGLE",
              role: "Figure",
              alt: "",
              x: 10,
              y: 20,
              width: 100,
              height: 80,
              readingOrder: 0,
            },
          ],
        },
      ],
    };
    const xssPreflight = runDryRunPreflight(xssScene);
    assert.equal(xssPreflight.canExport, false);
    // Feed SCAN_RESULT into ui.html handler — must populate textContent/value safely without innerHTML
    sandbox.window.onmessage({ data: { pluginMessage: { type: "SCAN_RESULT", scene: xssScene, preflight: xssPreflight } } });
    assert.ok(createdTexts.some((t) => t.includes(xssPayload)), "XSS string should be assigned purely via safe textContent");
    assert.equal(elementsById["nodes-container"].innerHTML, undefined);
    assert.equal(elementsById["preflight-box"].innerHTML, undefined);

    // URL & custom font validation
    assert.equal(normalizeApiBaseUrl("http://127.0.0.1:8000/").url, "http://127.0.0.1:8000");
    assert.equal(normalizeApiBaseUrl("https://compiler.agency.eu/api/").url, "https://compiler.agency.eu/api");
    assert.equal(normalizeApiBaseUrl("javascript:alert(1)").ok, false);
    assert.equal(normalizeApiBaseUrl("http://evil.example.com").ok, false);

    assert.equal(sanitizeCustomFontFilename("Inter Bold.TTF"), "Inter_Bold.ttf");
    assert.equal(sanitizeCustomFontFilename("../../etc/passwd.ttf"), "passwd.ttf");
    assert.equal(sanitizeCustomFontFilename("malware.exe"), null);
    assert.equal(sanitizeCustomFontFilename("font.woff2"), null);

    // Chunked base64 encoder handles large 256 KB buffer cleanly without stack overflow
    const bigBuf = new Uint8Array(256 * 1024);
    for (let i = 0; i < bigBuf.length; i++) bigBuf[i] = i & 255;
    assert.equal(uint8ArrayToBase64(bigBuf), Buffer.from(bigBuf).toString("base64"));
  });

  // NEW: Bundled dist/code.js runtime test (clientStorage persistence, TOGGLE_OVERLAY, PREPARE_EXPORT)
  await test("Bundle Runtime: dist/code.js handles INIT/SAVE_SETTINGS, TOGGLE_OVERLAY, and PREPARE_EXPORT cleanly", async () => {
    const bundlePath = path.join(rootDir, "apps", "figma-plugin", "dist", "code.js");
    const bundleSrc = fs.readFileSync(bundlePath, "utf8");
    const checkBundle = spawnSync(process.execPath, ["--check", bundlePath], { encoding: "utf8" });
    assert.equal(checkBundle.status, 0, `dist/code.js syntax error: ${checkBundle.stderr}`);

    const storage = new Map();
    const posted = [];
    const pluginDataStore = new Map();
    const bigPng = new Uint8Array(128 * 1024);
    bigPng.set(Buffer.from(SAMPLE_PNG_BASE64, "base64"), 0);

    const figNode = {
      id: "fig-1",
      name: "Hero Chart",
      type: "RECTANGLE",
      visible: true,
      x: 480,
      y: 80,
      width: 400,
      height: 240,
      absoluteBoundingBox: { x: 1480, y: 280, width: 400, height: 240 },
      fills: [{ type: "IMAGE", visible: true }],
      getPluginData: (k) => pluginDataStore.get(`fig-1:${k}`) || JSON.stringify({ role: "Figure", alt: "Revenue chart", userOverriddenFields: ["role", "alt"] }),
      setPluginData: (k, v) => pluginDataStore.set(`fig-1:${k}`, v),
      exportAsync: async (opts) => {
        assert.equal(opts.format, "PNG");
        assert.equal(opts.constraint.type, "SCALE");
        assert.equal(opts.constraint.value, 2);
        return bigPng;
      },
    };
    const titleNode = {
      id: "txt-1",
      name: "Heading",
      type: "TEXT",
      visible: true,
      x: 40,
      y: 40,
      width: 380,
      height: 44,
      absoluteBoundingBox: { x: 1040, y: 240, width: 380, height: 44 },
      characters: "Bundled Runtime Check",
      fontSize: 30,
      fontName: { family: "Inter", style: "Bold" },
      fills: [{ type: "SOLID", visible: true, color: { r: 15 / 255, g: 23 / 255, b: 42 / 255 } }],
      getPluginData: (k) => pluginDataStore.get(`txt-1:${k}`) || "",
      setPluginData: (k, v) => pluginDataStore.set(`txt-1:${k}`, v),
    };
    const mockFrame = {
      id: "frame-rt",
      name: "Runtime Frame",
      type: "FRAME",
      layoutMode: "NONE",
      visible: true,
      x: 1000,
      y: 200,
      width: 960,
      height: 540,
      absoluteBoundingBox: { x: 1000, y: 200, width: 960, height: 540 },
      fills: [{ type: "SOLID", visible: true, color: { r: 1, g: 1, b: 1 } }],
      children: [titleNode, figNode],
      getPluginData: () => "",
      appendChild(child) { this.children.push(child); },
    };
    const nodeMap = new Map([
      [mockFrame.id, mockFrame],
      [titleNode.id, titleNode],
      [figNode.id, figNode],
    ]);

    const mockFigma = {
      root: { name: "Mock Deck" },
      currentPage: {
        selection: [mockFrame],
        children: [mockFrame],
        getPluginData: (k) => pluginDataStore.get(`page:${k}`) || "",
        setPluginData: (k, v) => pluginDataStore.set(`page:${k}`, v),
        appendChild(c) { this.children.push(c); },
      },
      clientStorage: {
        getAsync: async (k) => storage.get(k),
        setAsync: async (k, v) => { storage.set(k, v); },
      },
      showUI() {},
      loadFontAsync: async () => {},
      createFrame: () => ({
        name: "",
        children: [],
        resize(w, h) { this.width = w; this.height = h; },
        appendChild(c) { this.children.push(c); },
      }),
      createText: () => ({ characters: "", fontSize: 10 }),
      group(nodes, parent) {
        parent.children = parent.children.filter((c) => !nodes.includes(c));
        const grp = {
          name: "Group",
          type: "GROUP",
          locked: false,
          children: nodes,
          remove() {
            parent.children = parent.children.filter((c) => c !== grp);
          },
        };
        parent.children.push(grp);
        return grp;
      },
      getNodeByIdAsync: async (id) => nodeMap.get(id) || null,
      ui: {
        onmessage: null,
        postMessage(m) { posted.push(m); },
      },
    };

    vm.runInNewContext(bundleSrc, { figma: mockFigma, __html__: "<html></html>", Uint8Array, console });
    await new Promise((r) => setTimeout(r, 10));

    // Persist settings via SAVE_SETTINGS
    await mockFigma.ui.onmessage({ type: "SAVE_SETTINGS", apiBaseUrl: "https://compiler.studio.eu/", layoutMode: "flow" });
    const persisted = storage.get("tagframe_settings_v1");
    assert.equal(persisted.apiBaseUrl, "https://compiler.studio.eu");
    assert.equal(persisted.layoutMode, "flow");

    // Toggle overlay ON -> creates locked __TagFrame_ReadingOrder_Overlay__
    await mockFigma.ui.onmessage({ type: "TOGGLE_OVERLAY" });
    const overlayGroup = mockFrame.children.find((c) => c.name === OVERLAY_GROUP_NAME);
    assert.ok(overlayGroup, "Expected __TagFrame_ReadingOrder_Overlay__ group on frame");
    assert.equal(overlayGroup.locked, true);

    // RESCAN while overlay is active -> overlay badges MUST NOT appear in SCAN_RESULT
    posted.length = 0;
    await mockFigma.ui.onmessage({ type: "RESCAN" });
    const scanMsg = posted.find((m) => m.type === "SCAN_RESULT");
    assert.equal(scanMsg.scene.frames[0].nodes.length, 2);
    assert.equal(scanMsg.overlayActive, true);

    // PREPARE_EXPORT -> exports 2x Figure PNG base64 without stack overflow
    posted.length = 0;
    await mockFigma.ui.onmessage({ type: "PREPARE_EXPORT", mode: "compile", layoutMode: "positioned" });
    const readyMsg = posted.find((m) => m.type === "EXPORT_READY");
    assert.ok(readyMsg);
    assert.equal(readyMsg.exportedFigures, 1);
    assert.equal(readyMsg.scene.layoutMode, "positioned");
    const exportedFig = readyMsg.scene.frames[0].nodes.find((n) => n.id === "fig-1");
    assert.equal(exportedFig.x, 480);
    assert.equal(exportedFig.y, 80);
    assert.equal(exportedFig.imageBase64, Buffer.from(bigPng).toString("base64"));

    // Toggle overlay OFF -> removes group cleanly
    await mockFigma.ui.onmessage({ type: "TOGGLE_OVERLAY" });
    assert.equal(mockFrame.children.some((c) => c.name === OVERLAY_GROUP_NAME), false);
  });

  // Dry-Run Preflight checks: low contrast, skipped heading H1 -> H3, missing Alt
  await test("Dry-Run Preflight catches WCAG AA contrast, H1->H3 skip, and missing Alt", async () => {
    const badScene = {
      title: "Preflight Check",
      lang: "en-US",
      frames: [
        {
          id: "f1",
          name: "Bad Slide",
          backgroundColor: "#FFFFFF",
          nodes: [
            { id: "h1", name: "Title", type: "TEXT", role: "H1", text: "Top", fontSize: 30, fontWeight: "Bold", color: "#0F172A", readingOrder: 0 },
            { id: "h3", name: "Sub", type: "TEXT", role: "H3", text: "Skipped H2", fontSize: 16, fontWeight: "Bold", color: "#CBD5E1", readingOrder: 1 },
            { id: "fig", name: "Hero Photo", type: "RECTANGLE", role: "Figure", alt: "", readingOrder: 2 },
          ],
        },
      ],
    };
    const pf = runDryRunPreflight(badScene);
    assert.equal(pf.canExport, false);
    assert.ok(pf.errors.some((e) => e.code === "SKIPPED_HEADING"));
    assert.ok(pf.errors.some((e) => e.code === "MISSING_ALT"));
    assert.ok(pf.warnings.some((w) => w.code === "LOW_CONTRAST"));
  });

  // FULL E2E TEST (BOTH `flow` AND `positioned`): Figma Plugin Engine -> Typst PDF/UA-1 Compiler -> pdfua_inspector.js PASS (0 failures)!
  await test("FULL E2E (flow + positioned): Figma Plugin Scene -> Typst PDF/UA-1 Compiler -> pdfua_inspector.js PASS (0 failures)", async () => {
    const figmaFrame = {
      id: "slide-e2e",
      name: "Agency Pitch Slide",
      x: 500,
      y: 300,
      width: 960,
      height: 540,
      absoluteBoundingBox: { x: 500, y: 300, width: 960, height: 540 },
      backgroundColor: "#F8FAFC",
      children: [
        {
          id: "ov-ignore",
          name: OVERLAY_GROUP_NAME,
          type: "GROUP",
          children: [{ id: "ov-badge-txt", name: "Badge", type: "TEXT", characters: "#1 H1", fontSize: 10 }],
        },
        {
          id: "bg-bar",
          name: "Accent Bar",
          type: "RECTANGLE",
          absoluteBoundingBox: { x: 500, y: 300, width: 960, height: 12 },
          pluginData: JSON.stringify({ role: "Artifact", userOverriddenFields: ["role"] }),
        },
        {
          id: "t1",
          name: "Slide Heading",
          type: "TEXT",
          absoluteBoundingBox: { x: 548, y: 332, width: 860, height: 42 },
          characters: "Accessible EAA Client Brief",
          fontSize: 30,
          fontWeight: "Bold",
          fontFamily: "DejaVu Sans",
          fillHex: "#0F172A",
        },
        {
          id: "t2",
          name: "Subtitle",
          type: "TEXT",
          absoluteBoundingBox: { x: 548, y: 392, width: 400, height: 32 },
          characters: "Executive Summary",
          fontSize: 20,
          fontWeight: "Bold",
          fontFamily: "DejaVu Sans",
          fillHex: "#1E293B",
        },
        {
          id: "t3",
          name: "Body",
          type: "TEXT",
          absoluteBoundingBox: { x: 548, y: 436, width: 400, height: 90 },
          characters: "Compiled end-to-end from Figma Plugin engine JSON into ISO 14289-1 PDF/UA-1.",
          fontSize: 14,
          fontWeight: "Regular",
          fontFamily: "DejaVu Sans",
          fillHex: "#0F172A",
        },
        {
          id: "f1",
          name: "Architecture Box",
          type: "RECTANGLE",
          absoluteBoundingBox: { x: 980, y: 392, width: 420, height: 140 },
          hasImageFill: true,
          imageBase64: SAMPLE_PNG_BASE64,
          pluginData: JSON.stringify({
            role: "Figure",
            alt: "Accessible architecture flow from Figma nodes to ISO 14289-1 PDF.",
            userOverriddenFields: ["role", "alt"],
          }),
        },
        {
          id: "tbl1",
          name: "Compliance Table",
          type: "FRAME",
          absoluteBoundingBox: { x: 548, y: 560, width: 852, height: 120 },
          headers: ["Metric", "Result"],
          rows: [["ISO 14289-1", "PASS"], ["Live Fonts", "Embedded"]],
          pluginData: JSON.stringify({ role: "Table", userOverriddenFields: ["role"] }),
        },
      ],
    };

    const extracted = extractAccessibleFrame(figmaFrame);
    assert.equal(extracted.nodes.some((n) => n.id === "ov-badge-txt"), false);

    for (const layoutMode of ["flow", "positioned"]) {
      const scene = {
        title: `E2E Verified Accessible Brief (${layoutMode})`,
        author: "TagFrame E2E",
        lang: "en-US",
        layoutMode,
        customFonts: [],
        frames: [extracted],
      };
      const pf = runDryRunPreflight(scene);
      assert.equal(pf.canExport, true, `Preflight unexpectedly blocked (${layoutMode}): ${JSON.stringify(pf.errors)}`);

      const out = compileViaPython(scene);
      assert.equal(out.telemetry.layout_mode, layoutMode, `Expected compiler layout_mode=${layoutMode}`);
      const pdfBytes = new Uint8Array(Buffer.from(out.pdf_b64, "base64"));

      const report = await inspectPdfUa(pdfBytes, `e2e_compiled_${layoutMode}.pdf`);
      assert.equal(report.ok, true, `Inspector ok=false for ${layoutMode}`);
      assert.equal(
        report.verdict,
        "PASS",
        `Inspector failed (${layoutMode}): ${JSON.stringify(report.checks.filter((c) => c.status !== "PASS"))}`
      );
      assert.equal(report.summary.fail, 0, `Expected 0 failures for ${layoutMode}`);
      assert.equal(report.metrics.hasPdfUaPart1, true);
      assert.equal(report.metrics.docLang, "en-US");
      assert.equal(report.metrics.tagCounts.H1, 1);
      assert.equal(report.metrics.tagCounts.H2, 1);
      assert.equal(report.metrics.tagCounts.Table, 1);
      assert.equal(report.metrics.tablesWithTh, 1);
      assert.equal(report.metrics.figures.length, 1);
      assert.equal(report.metrics.figures[0].hasAlt, true);
    }
  });

  console.log(`\nALL ${passed}/${passed} PLUGIN ENGINE & E2E TESTS PASSED!`);
}

run().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});

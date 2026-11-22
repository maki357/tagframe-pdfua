import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractAccessibleFrame, runDryRunPreflight } from "../apps/figma-plugin/src/engine.mjs";
import { inspectPdfUa } from "../apps/web/pdfua_inspector.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

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

  // FULL E2E TEST: Figma Plugin Engine -> Python Typst PDF/UA-1 Compiler -> JS Binary PDF/UA-1 Inspector -> 9/9 PASS!
  await test("FULL E2E: Figma Plugin Scene -> Typst PDF/UA-1 Compiler -> pdfua_inspector.js PASS (0 failures)", async () => {
    const figmaFrame = {
      id: "slide-e2e",
      name: "Agency Pitch Slide",
      width: 960,
      height: 540,
      backgroundColor: "#F8FAFC",
      children: [
        { id: "bg-bar", name: "Accent Bar", type: "RECTANGLE", y: 0, pluginData: JSON.stringify({ role: "Artifact", userOverriddenFields: ["role"] }) },
        { id: "t1", name: "Slide Heading", type: "TEXT", y: 20, characters: "Accessible EAA Client Brief", fontSize: 30, fontWeight: "Bold", fillHex: "#0F172A" },
        { id: "t2", name: "Subtitle", type: "TEXT", y: 80, characters: "Executive Summary", fontSize: 20, fontWeight: "Bold", fillHex: "#1E293B" },
        { id: "t3", name: "Body", type: "TEXT", y: 120, characters: "Compiled end-to-end from Figma Plugin engine JSON into ISO 14289-1 PDF/UA-1.", fontSize: 14, fontWeight: "Regular", fillHex: "#0F172A" },
        { id: "f1", name: "Architecture Box", type: "RECTANGLE", y: 180, hasImageFill: true, pluginData: JSON.stringify({ role: "Figure", alt: "Accessible architecture flow from Figma nodes to ISO 14289-1 PDF.", userOverriddenFields: ["role", "alt"] }) },
        { id: "tbl1", name: "Compliance Table", type: "FRAME", y: 260, headers: ["Metric", "Result"], rows: [["ISO 14289-1", "PASS"], ["Live Fonts", "Embedded"]], pluginData: JSON.stringify({ role: "Table", userOverriddenFields: ["role"] }) },
      ],
    };

    const extracted = extractAccessibleFrame(figmaFrame);
    const scene = { title: "E2E Verified Accessible Brief", author: "TagFrame E2E", lang: "en-US", frames: [extracted] };
    const pf = runDryRunPreflight(scene);
    assert.equal(pf.canExport, true, `Preflight unexpectedly blocked: ${JSON.stringify(pf.errors)}`);

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
    const out = JSON.parse(py.stdout);
    const pdfBytes = new Uint8Array(Buffer.from(out.pdf_b64, "base64"));

    const report = await inspectPdfUa(pdfBytes, "e2e_compiled.pdf");
    assert.equal(report.ok, true);
    assert.equal(report.verdict, "PASS", `Inspector failed: ${JSON.stringify(report.checks.filter((c) => c.status !== "PASS"))}`);
    assert.equal(report.summary.fail, 0);
    assert.equal(report.metrics.hasPdfUaPart1, true);
    assert.equal(report.metrics.docLang, "en-US");
    assert.equal(report.metrics.tagCounts.H1, 1);
    assert.equal(report.metrics.tagCounts.H2, 1);
    assert.equal(report.metrics.tagCounts.Table, 1);
    assert.equal(report.metrics.tablesWithTh, 1);
    assert.equal(report.metrics.figures.length, 1);
    assert.equal(report.metrics.figures[0].hasAlt, true);
  });

  console.log(`\nALL ${passed}/${passed} PLUGIN ENGINE & E2E TESTS PASSED!`);
}

run().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});

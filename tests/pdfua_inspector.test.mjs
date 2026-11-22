import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { inspectPdfUa } from "../apps/web/pdfua_inspector.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const samplesDir = path.resolve(__dirname, "../apps/web/samples");

function buildSyntheticPdf(objects) {
  let out = "%PDF-1.7\n";
  for (const [num, body] of objects) {
    out += `${num} 0 obj\n${body}\nendobj\n`;
  }
  out += "trailer\n<< /Root 1 0 R >>\n%%EOF\n";
  return new TextEncoder().encode(out);
}

function buildCompressedObjStmPdf() {
  const obj1 = "<< /Type /Catalog /Pages 2 0 R /Lang (de-DE) /MarkInfo << /Marked true >> /ViewerPreferences << /DisplayDocTitle true >> /StructTreeRoot 4 0 R >>";
  const obj4 = "<< /Type /StructTreeRoot /K [5 0 R] >>";
  const obj5 = "<< /Type /StructElem /S /H1 /P 4 0 R >>";
  const body = `${obj1}\n${obj4}\n${obj5}`;
  const off1 = 0;
  const off4 = obj1.length + 1;
  const off5 = off4 + obj4.length + 1;
  const header = `1 ${off1} 4 ${off4} 5 ${off5} `;
  const compressed = zlib.deflateSync(Buffer.from(header + body, "latin1"));

  const prefix = Buffer.from(
    `%PDF-1.7\n` +
      `2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n` +
      `3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 6 0 R >> >> /Contents 7 0 R >>\nendobj\n` +
      `6 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n` +
      `7 0 obj\n<< /Length 22 >>\nstream\nBT /F1 12 Tf (Hi) Tj ET\nendstream\nendobj\n` +
      `10 0 obj\n<< /Type /ObjStm /N 3 /First ${header.length} /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`,
    "latin1"
  );
  const suffix = Buffer.from(`\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`, "latin1");
  return new Uint8Array(Buffer.concat([prefix, compressed, suffix]));
}

async function runTests() {
  let passed = 0;
  async function test(name, fn) {
    await fn();
    passed++;
    console.log(`PASS: ${name}`);
  }

  await test("Real BEFORE sample fails all critical ISO 14289-1 checks & detects 0-font outlined/raster text", async () => {
    const bytes = fs.readFileSync(path.join(samplesDir, "sample_before_figma_style_untagged.pdf"));
    const res = await inspectPdfUa(bytes, "sample_before_figma_style_untagged.pdf");
    assert.equal(res.ok, true);
    assert.equal(res.verdict, "FAIL");
    assert.equal(res.pageCount, 2);
    assert.equal(res.metrics.fontCount, 0);
    assert.equal(res.metrics.textOpCount, 0);
    assert.equal(res.metrics.totalStructElems, 0);
    assert.equal(res.metrics.hasPdfUaPart1, false);
    assert.equal(res.metrics.isMarked, false);
    assert.equal(res.metrics.docLang, null);
    assert.ok(res.summary.fail >= 7, `Expected >=7 failures, got ${res.summary.fail}`);
  });

  await test("Real AFTER sample (Typst 0.15.2 pdf_standards=['ua-1']) passes ALL ISO 14289-1 machine checks", async () => {
    const bytes = fs.readFileSync(path.join(samplesDir, "sample_after_tagframe_pdfua1.pdf"));
    const res = await inspectPdfUa(bytes, "sample_after_tagframe_pdfua1.pdf");
    assert.equal(res.ok, true);
    assert.equal(res.verdict, "PASS", `Unexpected failures: ${JSON.stringify(res.checks.filter((c) => c.status !== "PASS"))}`);
    assert.equal(res.summary.fail, 0);
    assert.equal(res.summary.warn, 0);
    assert.equal(res.pageCount, 2);
    assert.equal(res.metrics.hasPdfUaPart1, true);
    assert.equal(res.metrics.isMarked, true);
    assert.equal(res.metrics.docLang, "en-US");
    assert.equal(res.metrics.displayDocTitle, true);
    assert.equal(res.metrics.tagCounts.H1, 1);
    assert.equal(res.metrics.tagCounts.H2, 2);
    assert.equal(res.metrics.tagCounts.Table, 1);
    assert.equal(res.metrics.tablesWithTh, 1);
    assert.equal(res.metrics.figures.length, 1);
    assert.equal(res.metrics.figures[0].hasAlt, true);
    assert.ok(res.metrics.fontCount >= 4);
    assert.equal(res.metrics.fontsWithToUnicode, res.metrics.fontCount);
    assert.ok(res.metrics.textOpCount > 0);
  });

  await test("Edge Case: Unpacks FlateDecode /ObjStm compressed Catalog & StructTreeRoot", async () => {
    const bytes = buildCompressedObjStmPdf();
    const res = await inspectPdfUa(bytes, "compressed_objstm.pdf");
    assert.equal(res.ok, true);
    assert.equal(res.unpackedObjStmCount, 3);
    assert.equal(res.metrics.docLang, "de-DE");
    assert.equal(res.metrics.isMarked, true);
    assert.equal(res.metrics.displayDocTitle, true);
    assert.equal(res.metrics.tagCounts.H1, 1);
    assert.equal(res.metrics.fontCount, 1);
    assert.equal(res.metrics.textOpCount, 1);
  });

  await test("Edge Case: Flags H1 -> H3 skipped heading level AND /Figure missing /Alt", async () => {
    const bytes = buildSyntheticPdf([
      [1, "<< /Type /Catalog /Pages 2 0 R /Lang (en-US) /MarkInfo << /Marked true >> /StructTreeRoot 4 0 R >>"],
      [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
      [3, "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 9 0 R >> >> /Contents 10 0 R >>"],
      [4, "<< /Type /StructTreeRoot /K [5 0 R 6 0 R 7 0 R 8 0 R] >>"],
      [5, "<< /Type /StructElem /S /H1 /P 4 0 R >>"],
      [6, "<< /Type /StructElem /S /H3 /P 4 0 R >>"],
      [7, "<< /Type /StructElem /S /Figure /P 4 0 R >>"],
      [8, "<< /Type /StructElem /S /Table /P 4 0 R /K [11 0 R] >>"],
      [9, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"],
      [10, "<< /Length 22 >>\nstream\nBT /F1 12 Tf (Hi) Tj ET\nendstream"],
      [11, "<< /Type /StructElem /S /TD /P 8 0 R >>"],
    ]);
    const res = await inspectPdfUa(bytes, "broken_headings_and_alt.pdf");
    assert.equal(res.ok, true);
    assert.deepEqual(res.metrics.headingSkips, ["H1 → H3"]);
    assert.equal(res.checks.find((c) => c.id === "heading_hierarchy").status, "FAIL");
    assert.equal(res.checks.find((c) => c.id === "figure_alt_text").status, "FAIL");
    assert.equal(res.checks.find((c) => c.id === "table_headers").status, "FAIL");
  });

  await test("Edge Case: Cleanly rejects empty buffer and non-PDF file", async () => {
    const rEmpty = await inspectPdfUa(new Uint8Array(0), "empty.pdf");
    assert.equal(rEmpty.ok, false);
    const rTxt = await inspectPdfUa(new TextEncoder().encode("<html>not a pdf</html>"), "fake.pdf");
    assert.equal(rTxt.ok, false);
    assert.match(rTxt.error, /Not a valid PDF/);
  });

  await test("Edge Case: Cleanly flags password-protected /Encrypt PDF", async () => {
    const bytes = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R /Encrypt 2 0 R >>\n%%EOF");
    const res = await inspectPdfUa(bytes, "locked.pdf");
    assert.equal(res.ok, false);
    assert.equal(res.encrypted, true);
  });

  await test("Edge Case: Enforces 50 MB memory safety guard without crashing", async () => {
    const fakeBig = new Uint8Array(50 * 1024 * 1024 + 16);
    const res = await inspectPdfUa(fakeBig, "huge.pdf");
    assert.equal(res.ok, false);
    assert.match(res.error, /50 MB/);
  });

  console.log(`\nALL ${passed}/${passed} INSPECTOR TESTS PASSED!`);
}

runTests().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});

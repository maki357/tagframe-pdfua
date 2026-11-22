/**
 * TagFrame PDF/UA — Zero-Upload Client-Side PDF/UA-1 (ISO 14289-1) Structural Inspector
 *
 * Pure ES Module (runs identically in modern browsers and Node.js 20+ via Web DecompressionStream).
 * Zero network requests, zero files written to disk, zero external dependencies.
 *
 * Capabilities:
 * - Parses PDF 1.4–2.0 indirect objects (`N G obj ... endobj`)
 * - Inflates `/FlateDecode` streams and unpacks PDF 1.5+ compressed `/ObjStm` object streams
 * - Decodes PDF literal strings (including UTF-16BE BOM) and hex strings (`<FEFF...>`)
 * - Inspects Catalog, `/MarkInfo`, `/Lang`, `/ViewerPreferences`, XMP `/Metadata` (`pdfuaid:part`),
 *   recursive `/StructTreeRoot` (with `/RoleMap` resolution), `/Font` + `/ToUnicode`, and content streams
 */

const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB in-RAM browser safety guard

function bytesToLatin1(bytes, start = 0, end = bytes.length) {
  let out = "";
  const chunkSize = 0x8000;
  for (let i = start; i < end; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(i + chunkSize, end));
    out += String.fromCharCode(...slice);
  }
  return out;
}

function bytesToUtf8(bytes) {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

async function inflateFlate(rawBytes) {
  // Trim leading/trailing whitespace that PDF streams occasionally carry before deflate header
  let start = 0;
  while (start < rawBytes.length && (rawBytes[start] === 0x0d || rawBytes[start] === 0x0a)) {
    start++;
  }
  const trimmed = start > 0 ? rawBytes.subarray(start) : rawBytes;

  async function tryFormat(fmt) {
    const ds = new DecompressionStream(fmt);
    const writer = ds.writable.getWriter();
    writer.write(trimmed).catch(() => {});
    writer.close().catch(() => {});
    const reader = ds.readable.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.length;
    }
    return merged;
  }

  try {
    return await tryFormat("deflate");
  } catch {
    try {
      return await tryFormat("deflate-raw");
    } catch {
      return null;
    }
  }
}

function decodePdfString(token) {
  if (!token) return "";
  const t = token.trim();
  if (t.startsWith("(") && t.endsWith(")")) {
    const inner = t.slice(1, -1);
    const bytes = [];
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if (ch === "\\" && i + 1 < inner.length) {
        const next = inner[++i];
        if (next === "n") bytes.push(10);
        else if (next === "r") bytes.push(13);
        else if (next === "t") bytes.push(9);
        else if (next === "b") bytes.push(8);
        else if (next === "f") bytes.push(12);
        else if (next === "(" || next === ")" || next === "\\") bytes.push(next.charCodeAt(0));
        else if (/[0-7]/.test(next)) {
          let oct = next;
          if (i + 1 < inner.length && /[0-7]/.test(inner[i + 1])) oct += inner[++i];
          if (i + 1 < inner.length && /[0-7]/.test(inner[i + 1])) oct += inner[++i];
          bytes.push(parseInt(oct, 8) & 0xff);
        } else if (next === "\r" || next === "\n") {
          if (next === "\r" && inner[i + 1] === "\n") i++;
        } else {
          bytes.push(next.charCodeAt(0));
        }
      } else {
        bytes.push(ch.charCodeAt(0) & 0xff);
      }
    }
    return decodePdfStringBytes(new Uint8Array(bytes));
  }
  if (t.startsWith("<") && t.endsWith(">") && !t.startsWith("<<")) {
    const hex = t.slice(1, -1).replace(/\s+/g, "");
    const padded = hex.length % 2 === 1 ? hex + "0" : hex;
    const bytes = new Uint8Array(padded.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16) || 0;
    }
    return decodePdfStringBytes(bytes);
  }
  return t;
}

function decodePdfStringBytes(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let out = "";
    for (let i = 2; i + 1 < bytes.length; i += 2) {
      out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    }
    return out;
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytesToUtf8(bytes.subarray(3));
  }
  return bytesToUtf8(bytes);
}

/**
 * Find the matching balanced dictionary `<< ... >>`, array `[ ... ]`, or literal string `( ... )`
 */
function extractBalanced(str, startIdx) {
  const ch = str[startIdx];
  if (ch === "(") {
    let depth = 1;
    let i = startIdx + 1;
    while (i < str.length && depth > 0) {
      if (str[i] === "\\") {
        i += 2;
        continue;
      }
      if (str[i] === "(") depth++;
      else if (str[i] === ")") depth--;
      i++;
    }
    return { text: str.slice(startIdx, i), end: i };
  }
  if (ch === "<" && str[startIdx + 1] === "<") {
    let depth = 1;
    let i = startIdx + 2;
    while (i < str.length && depth > 0) {
      if (str[i] === "(") {
        const s = extractBalanced(str, i);
        i = s.end;
        continue;
      }
      if (str[i] === "<" && str[i + 1] === "<") {
        depth++;
        i += 2;
      } else if (str[i] === ">" && str[i + 1] === ">") {
        depth--;
        i += 2;
      } else {
        i++;
      }
    }
    return { text: str.slice(startIdx, i), end: i };
  }
  if (ch === "<") {
    const end = str.indexOf(">", startIdx + 1);
    const e = end === -1 ? str.length : end + 1;
    return { text: str.slice(startIdx, e), end: e };
  }
  if (ch === "[") {
    let depth = 1;
    let i = startIdx + 1;
    while (i < str.length && depth > 0) {
      if (str[i] === "(") {
        const s = extractBalanced(str, i);
        i = s.end;
        continue;
      }
      if (str[i] === "[") depth++;
      else if (str[i] === "]") depth--;
      i++;
    }
    return { text: str.slice(startIdx, i), end: i };
  }
  return { text: "", end: startIdx };
}

/**
 * Parse a top-level PDF dictionary string `<< /Key Value ... >>` into a JS Map<string, string>
 * Values remain raw PDF tokens (refs like `12 0 R`, nested `<<...>>`, arrays `[...]`, names `/Foo`, strings `(...)`, booleans/numbers).
 */
function parseDict(dictStr) {
  const map = new Map();
  if (!dictStr) return map;
  const s = dictStr.trim();
  if (!s.startsWith("<<")) return map;
  let i = 2;
  const limit = s.endsWith(">>") ? s.length - 2 : s.length;

  function skipWs() {
    while (i < limit) {
      const c = s[i];
      if (c === " " || c === "\t" || c === "\r" || c === "\n" || c === "\f" || c === "\0") {
        i++;
      } else if (c === "%") {
        while (i < limit && s[i] !== "\n" && s[i] !== "\r") i++;
      } else {
        break;
      }
    }
  }

  while (i < limit) {
    skipWs();
    if (i >= limit || s[i] !== "/") break;
    const keyStart = i;
    i++;
    while (i < limit && !/[\s<>\[\]()\/%{}]/.test(s[i])) i++;
    const key = s.slice(keyStart, i);
    skipWs();
    if (i >= limit) break;

    let val = "";
    const c = s[i];
    if (c === "(" || c === "[" || c === "<") {
      const b = extractBalanced(s, i);
      val = b.text;
      i = b.end;
    } else if (c === "/") {
      const vStart = i;
      i++;
      while (i < limit && !/[\s<>\[\]()\/%{}]/.test(s[i])) i++;
      val = s.slice(vStart, i);
    } else {
      // Could be indirect ref `12 0 R`, number, boolean, or null
      const rest = s.slice(i, limit);
      const refMatch = rest.match(/^(\d+\s+\d+\s+R)(?=[\s<>\[\]()\/%]|$)/);
      if (refMatch) {
        val = refMatch[1].replace(/\s+/g, " ");
        i += refMatch[0].length;
      } else {
        const tokMatch = rest.match(/^([^\s<>\[\]()\/%]+)/);
        if (tokMatch) {
          val = tokMatch[1];
          i += tokMatch[0].length;
        } else {
          i++;
        }
      }
    }
    map.set(key, val);
  }
  return map;
}

function parseRefNum(token) {
  if (!token) return null;
  const m = token.trim().match(/^(\d+)\s+\d+\s+R$/);
  return m ? Number(m[1]) : null;
}

function extractAllRefs(token) {
  if (!token) return [];
  const refs = [];
  const re = /(\d+)\s+\d+\s+R/g;
  let m;
  while ((m = re.exec(token)) !== null) {
    refs.push(Number(m[1]));
  }
  return refs;
}

/**
 * Extract all top-level indirect objects (`N G obj ... endobj`) plus raw stream byte ranges.
 */
function scanTopLevelObjects(bytes) {
  const latin1 = bytesToLatin1(bytes);
  const objects = new Map();
  const objStms = [];
  const objHeaderRe = /(?:^|[\r\n\s])(\d+)\s+(\d+)\s+obj(?=[\s<\[\/(])/g;

  let m;
  while ((m = objHeaderRe.exec(latin1)) !== null) {
    const objNum = Number(m[1]);
    const byteOffset = m.index;
    let bodyStart = m.index + m[0].length;
    while (bodyStart < latin1.length && /\s/.test(latin1[bodyStart])) bodyStart++;

    let dictText = "";
    let dictEnd = bodyStart;
    if (latin1[bodyStart] === "<" && latin1[bodyStart + 1] === "<") {
      const b = extractBalanced(latin1, bodyStart);
      dictText = b.text;
      dictEnd = b.end;
    }

    // Check if followed by `stream`
    let afterDict = dictEnd;
    while (afterDict < latin1.length && (latin1[afterDict] === " " || latin1[afterDict] === "\t" || latin1[afterDict] === "\r" || latin1[afterDict] === "\n")) {
      afterDict++;
    }

    let streamStart = -1;
    let streamEnd = -1;
    let objEnd = -1;

    if (dictText && latin1.startsWith("stream", afterDict)) {
      let sStart = afterDict + 6;
      if (latin1[sStart] === "\r" && latin1[sStart + 1] === "\n") sStart += 2;
      else if (latin1[sStart] === "\n" || latin1[sStart] === "\r") sStart += 1;
      streamStart = sStart;

      // Try explicit direct integer /Length first so binary streams containing "endstream" are safe
      const dictMap = parseDict(dictText);
      const lenTok = dictMap.get("/Length");
      let explicitLen = lenTok && /^\d+$/.test(lenTok.trim()) ? Number(lenTok.trim()) : null;

      if (explicitLen !== null && streamStart + explicitLen <= latin1.length) {
        streamEnd = streamStart + explicitLen;
        const endObjIdx = latin1.indexOf("endobj", streamEnd);
        objEnd = endObjIdx === -1 ? latin1.length : endObjIdx;
      } else {
        const endStreamIdx = latin1.indexOf("endstream", streamStart);
        streamEnd = endStreamIdx === -1 ? latin1.length : endStreamIdx;
        // Strip single trailing EOL before endstream
        if (streamEnd > streamStart && latin1[streamEnd - 1] === "\n") streamEnd--;
        if (streamEnd > streamStart && latin1[streamEnd - 1] === "\r") streamEnd--;
        const endObjIdx = latin1.indexOf("endobj", endStreamIdx === -1 ? streamEnd : endStreamIdx);
        objEnd = endObjIdx === -1 ? latin1.length : endObjIdx;
      }

      const entry = {
        objNum,
        dictText,
        dict: dictMap,
        rawText: dictText,
        streamBytes: bytes.subarray(streamStart, streamEnd),
        byteOffset,
      };
      objects.set(objNum, entry);
      if (dictMap.get("/Type") === "/ObjStm") {
        objStms.push(entry);
      }
      objHeaderRe.lastIndex = objEnd + 6;
    } else {
      const endObjIdx = latin1.indexOf("endobj", dictEnd);
      objEnd = endObjIdx === -1 ? latin1.length : endObjIdx;
      const rawText = latin1.slice(bodyStart, objEnd).trim();
      objects.set(objNum, {
        objNum,
        dictText: dictText || (rawText.startsWith("<<") ? extractBalanced(rawText, 0).text : ""),
        dict: dictText ? parseDict(dictText) : rawText.startsWith("<<") ? parseDict(extractBalanced(rawText, 0).text) : new Map(),
        rawText,
        streamBytes: null,
        byteOffset,
      });
      objHeaderRe.lastIndex = objEnd + 6;
    }
  }

  return { latin1, objects, objStms };
}

/**
 * Unpack PDF 1.5+ compressed Object Streams (`/Type /ObjStm`) into the `objects` map,
 * preserving incremental-update precedence by keeping the highest byte offset per object number.
 */
async function unpackObjectStreams(objects, discoveredObjStms = null) {
  let unpackedCount = 0;
  const objStms = Array.isArray(discoveredObjStms)
    ? [...discoveredObjStms]
    : Array.from(objects.values()).filter((obj) => obj.dict.get("/Type") === "/ObjStm" && obj.streamBytes);
  objStms.sort((a, b) => (a.byteOffset ?? 0) - (b.byteOffset ?? 0));

  for (const stm of objStms) {
    const filter = stm.dict.get("/Filter") || "";
    const first = Number(stm.dict.get("/First") || 0);
    const n = Number(stm.dict.get("/N") || 0);
    if (!first || !n) continue;

    let decoded = stm.streamBytes;
    if (filter.includes("/FlateDecode")) {
      decoded = await inflateFlate(stm.streamBytes);
      if (!decoded) continue;
    }
    const text = bytesToLatin1(decoded);
    const header = text.slice(0, first).trim();
    const nums = header.split(/\s+/).map(Number);
    if (nums.length < n * 2) continue;

    const stmOffset = stm.byteOffset ?? 0;
    for (let i = 0; i < n; i++) {
      const childNum = nums[i * 2];
      const relOffset = nums[i * 2 + 1];
      const nextRelOffset = i + 1 < n ? nums[(i + 1) * 2 + 1] : text.length - first;
      const rawText = text.slice(first + relOffset, first + nextRelOffset).trim();
      const dictText = rawText.startsWith("<<") ? extractBalanced(rawText, 0).text : "";
      const existing = objects.get(childNum);
      // Keep whichever definition appears later in the PDF byte stream (incremental updates win;
      // earlier /ObjStm entries never clobber newer top-level or later-/ObjStm updates).
      if (!existing || stmOffset >= (existing.byteOffset ?? -1)) {
        objects.set(childNum, {
          objNum: childNum,
          dictText,
          dict: dictText ? parseDict(dictText) : new Map(),
          rawText,
          streamBytes: null,
          fromObjStm: true,
          byteOffset: stmOffset,
        });
        unpackedCount++;
      }
    }
  }
  return unpackedCount;
}

function resolveObj(objects, tokenOrNum) {
  if (typeof tokenOrNum === "number") return objects.get(tokenOrNum) || null;
  const num = parseRefNum(tokenOrNum);
  if (num !== null) return objects.get(num) || null;
  if (typeof tokenOrNum === "string" && tokenOrNum.trim().startsWith("<<")) {
    const dictText = extractBalanced(tokenOrNum.trim(), 0).text;
    return { objNum: null, dictText, dict: parseDict(dictText), rawText: dictText, streamBytes: null };
  }
  return null;
}

function getDictFromToken(objects, token) {
  const obj = resolveObj(objects, token);
  return obj ? obj.dict : new Map();
}

/**
 * Inspect any PDF byte buffer (`Uint8Array` or `ArrayBuffer`) for ISO 14289-1 (PDF/UA-1) structural compliance.
 */
export async function inspectPdfUa(inputBytes, filename = "document.pdf") {
  const bytes = inputBytes instanceof Uint8Array ? inputBytes : new Uint8Array(inputBytes);

  if (!bytes || bytes.length === 0) {
    return { ok: false, error: "File is empty (0 bytes).", filename };
  }
  if (bytes.length > MAX_FILE_BYTES) {
    return { ok: false, error: `File exceeds the 50 MB client-side safety limit (${(bytes.length / 1048576).toFixed(1)} MB).`, filename };
  }

  const head = bytesToLatin1(bytes, 0, Math.min(1024, bytes.length));
  const versionMatch = head.match(/%PDF-(\d+\.\d+)/);
  if (!versionMatch) {
    return { ok: false, error: "Not a valid PDF file (missing %PDF- header signature).", filename };
  }
  const pdfVersion = versionMatch[1];

  const { latin1, objects, objStms } = scanTopLevelObjects(bytes);

  // Check encryption first
  const isEncrypted =
    /\/Encrypt\s+\d+\s+\d+\s+R/.test(latin1) ||
    /\/Encrypt\s*<</.test(latin1) ||
    Array.from(objects.values()).some((o) => o.dict.has("/Encrypt"));
  if (isEncrypted) {
    return {
      ok: false,
      encrypted: true,
      error: "This PDF is encrypted/password-protected (/Encrypt present). Unlock the PDF first before running structural PDF/UA inspection.",
      filename,
      pdfVersion,
    };
  }

  const unpackedObjStmCount = await unpackObjectStreams(objects, objStms);

  // Locate Catalog (/Type /Catalog) preferring the latest /Root reference or highest byteOffset Catalog
  let catalog = null;
  const rootMatches = [...latin1.matchAll(/\/Root\s+(\d+)\s+\d+\s+R/g)];
  if (rootMatches.length > 0) {
    const latestRootNum = Number(rootMatches[rootMatches.length - 1][1]);
    const cand = objects.get(latestRootNum);
    if (cand && cand.dict.get("/Type") === "/Catalog") {
      catalog = cand;
    } else if (cand) {
      catalog = cand;
    }
  }
  if (!catalog) {
    for (const obj of objects.values()) {
      if (obj.dict.get("/Type") === "/Catalog") {
        if (!catalog || (obj.byteOffset ?? -1) >= (catalog.byteOffset ?? -1)) {
          catalog = obj;
        }
      }
    }
  }

  let infoDict = new Map();
  const infoMatches = [...latin1.matchAll(/\/Info\s+(\d+)\s+\d+\s+R/g)];
  if (infoMatches.length > 0) {
    const infoObj = objects.get(Number(infoMatches[infoMatches.length - 1][1]));
    if (infoObj) infoDict = infoObj.dict;
  } else {
    for (const obj of objects.values()) {
      if (obj.dict.has("/Producer") || obj.dict.has("/Creator")) {
        infoDict = obj.dict;
        break;
      }
    }
  }

  const producer = decodePdfString(infoDict.get("/Producer") || "");
  const creator = decodePdfString(infoDict.get("/Creator") || "");
  const infoTitle = decodePdfString(infoDict.get("/Title") || "");

  // Count pages
  const pageObjs = [];
  for (const obj of objects.values()) {
    if (obj.dict.get("/Type") === "/Page") {
      pageObjs.push(obj);
    }
  }
  let pageCount = pageObjs.length;
  if (pageCount === 0 && catalog) {
    const pagesObj = resolveObj(objects, catalog.dict.get("/Pages"));
    if (pagesObj && pagesObj.dict.get("/Count")) {
      pageCount = Number(pagesObj.dict.get("/Count")) || 0;
    }
  }

  // Extract XMP Metadata
  let xmpText = "";
  if (catalog && catalog.dict.has("/Metadata")) {
    const metaObj = resolveObj(objects, catalog.dict.get("/Metadata"));
    if (metaObj && metaObj.streamBytes) {
      const f = metaObj.dict.get("/Filter") || "";
      const rawMeta = f.includes("/FlateDecode") ? await inflateFlate(metaObj.streamBytes) : metaObj.streamBytes;
      if (rawMeta) xmpText = bytesToUtf8(rawMeta);
    }
  }
  const hasPdfUaPart1 =
    /pdfuaid:part\s*>\s*1\s*</i.test(xmpText) ||
    /pdfuaid:part\s*=\s*["']1["']/i.test(xmpText);
  const xmpTitleMatch = xmpText.match(/<dc:title[\s\S]*?<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/i);
  const xmpTitle = xmpTitleMatch ? xmpTitleMatch[1].trim() : "";
  const docTitle = xmpTitle || infoTitle;

  const xmpCreatorMatch = xmpText.match(/<xmp:CreatorTool>([\s\S]*?)<\/xmp:CreatorTool>/i);
  const xmpProducerMatch = xmpText.match(/<pdf:Producer>([\s\S]*?)<\/pdf:Producer>/i);
  const detectedTool = [producer, creator, xmpProducerMatch?.[1] || "", xmpCreatorMatch?.[1] || ""]
    .filter(Boolean)
    .join(" · ")
    .slice(0, 140);

  // Catalog properties: /Lang, /MarkInfo, /ViewerPreferences
  const docLang = catalog ? decodePdfString(catalog.dict.get("/Lang") || "").trim() : "";
  const markInfoDict = catalog && catalog.dict.has("/MarkInfo") ? getDictFromToken(objects, catalog.dict.get("/MarkInfo")) : new Map();
  const isMarked = (markInfoDict.get("/Marked") || "").toLowerCase() === "true";
  const hasSuspects = (markInfoDict.get("/Suspects") || "").toLowerCase() === "true";

  const vpDict = catalog && catalog.dict.has("/ViewerPreferences") ? getDictFromToken(objects, catalog.dict.get("/ViewerPreferences")) : new Map();
  const displayDocTitle = (vpDict.get("/DisplayDocTitle") || "").toLowerCase() === "true";

  // Recursive /StructTreeRoot inspection
  const hasStructTreeRoot = Boolean(catalog && catalog.dict.has("/StructTreeRoot"));
  const tagCounts = {};
  const headingsSequence = [];
  const figures = [];
  let tableCount = 0;
  let tablesWithTh = 0;
  let totalStructElems = 0;

  if (hasStructTreeRoot) {
    const stObj = resolveObj(objects, catalog.dict.get("/StructTreeRoot"));
    const roleMap = stObj && stObj.dict.has("/RoleMap") ? getDictFromToken(objects, stObj.dict.get("/RoleMap")) : new Map();

    const visited = new Set();
    function mapRole(rawS) {
      if (!rawS) return "";
      let cur = rawS.startsWith("/") ? rawS : "/" + rawS;
      const seen = new Set();
      while (roleMap.has(cur) && !seen.has(cur)) {
        seen.add(cur);
        cur = roleMap.get(cur);
      }
      return cur.replace(/^\//, "");
    }

    function walkStruct(tokenOrObj, insideTableCtx = null) {
      let obj = null;
      if (typeof tokenOrObj === "number") {
        if (visited.has(tokenOrObj)) return;
        visited.add(tokenOrObj);
        obj = objects.get(tokenOrObj);
      } else if (typeof tokenOrObj === "string") {
        const trimmed = tokenOrObj.trim();
        if (trimmed.startsWith("[")) {
          // Iterate child refs and inline dicts in document order
          const inner = trimmed.slice(1, -1);
          let idx = 0;
          while (idx < inner.length) {
            while (idx < inner.length && /\s/.test(inner[idx])) idx++;
            if (idx >= inner.length) break;
            if (inner[idx] === "<" && inner[idx + 1] === "<") {
              const b = extractBalanced(inner, idx);
              walkStruct(b.text, insideTableCtx);
              idx = b.end;
            } else {
              const refM = inner.slice(idx).match(/^(\d+)\s+\d+\s+R/);
              if (refM) {
                walkStruct(Number(refM[1]), insideTableCtx);
                idx += refM[0].length;
              } else {
                // Skip bare MCID integers or other tokens
                const tokM = inner.slice(idx).match(/^[^\s<>\[\]]+/);
                idx += tokM ? tokM[0].length : 1;
              }
            }
          }
          return;
        }
        const refNum = parseRefNum(trimmed);
        if (refNum !== null) {
          walkStruct(refNum, insideTableCtx);
          return;
        }
        if (trimmed.startsWith("<<")) {
          obj = resolveObj(objects, trimmed);
        }
      } else if (tokenOrObj && tokenOrObj.dict) {
        if (tokenOrObj.objNum !== null) {
          if (visited.has(tokenOrObj.objNum)) return;
          visited.add(tokenOrObj.objNum);
        }
        obj = tokenOrObj;
      }

      if (!obj || !obj.dict) return;

      const rawS = obj.dict.get("/S");
      let nextTableCtx = insideTableCtx;

      if (rawS) {
        const role = mapRole(rawS);
        totalStructElems++;
        tagCounts[role] = (tagCounts[role] || 0) + 1;

        if (/^H[1-6]$/.test(role)) {
          headingsSequence.push(role);
        }
        if (role === "Figure") {
          const alt = decodePdfString(obj.dict.get("/Alt") || "").trim();
          const actualText = decodePdfString(obj.dict.get("/ActualText") || "").trim();
          figures.push({ hasAlt: Boolean(alt || actualText), alt: alt || actualText });
        }
        if (role === "Table") {
          tableCount++;
          nextTableCtx = { hasTh: false };
        }
        if (role === "TH" && insideTableCtx) {
          insideTableCtx.hasTh = true;
        }
      }

      if (obj.dict.has("/K")) {
        walkStruct(obj.dict.get("/K"), nextTableCtx);
      }

      if (rawS && mapRole(rawS) === "Table" && nextTableCtx && nextTableCtx.hasTh) {
        tablesWithTh++;
      }
    }

    if (stObj) walkStruct(stObj);
  }

  // Heading skip check (e.g. H1 -> H3 without H2)
  const headingSkips = [];
  for (let i = 1; i < headingsSequence.length; i++) {
    const prev = Number(headingsSequence[i - 1].slice(1));
    const cur = Number(headingsSequence[i].slice(1));
    if (cur > prev + 1) {
      headingSkips.push(`${headingsSequence[i - 1]} → ${headingsSequence[i]}`);
    }
  }

  // Font & /ToUnicode & Content Stream Text vs Vector Outlines analysis
  const seenFontIds = new Set();
  let fontCount = 0;
  let fontsWithToUnicode = 0;
  let embeddedFontFiles = 0;

  function inspectFontObj(fObj, keyHint) {
    if (!fObj || !fObj.dict) return;
    const subtype = fObj.dict.get("/Subtype") || "";
    // Per ISO 32000-1, CIDFontType0/CIDFontType2 are internal descendants of a Type0 font
    // and never carry /ToUnicode directly (the parent /Type0 font holds /ToUnicode).
    if (subtype === "/CIDFontType0" || subtype === "/CIDFontType2") return;
    const fid = fObj.objNum !== null ? `obj_${fObj.objNum}` : `inline_${keyHint}`;
    if (seenFontIds.has(fid)) return;
    seenFontIds.add(fid);
    fontCount++;

    const encoding = fObj.dict.get("/Encoding") || "";
    const hasToUni =
      fObj.dict.has("/ToUnicode") ||
      (subtype === "/Type1" && (/WinAnsiEncoding|MacRomanEncoding/.test(encoding) || !encoding));
    if (hasToUni) fontsWithToUnicode++;

    // Check embedded font file via FontDescriptor (direct or inside DescendantFonts for Type0)
    let hasEmbedded = false;
    const checkDesc = (descTok) => {
      const desc = resolveObj(objects, descTok);
      if (desc && (desc.dict.has("/FontFile") || desc.dict.has("/FontFile2") || desc.dict.has("/FontFile3"))) {
        hasEmbedded = true;
      }
    };
    if (fObj.dict.has("/FontDescriptor")) checkDesc(fObj.dict.get("/FontDescriptor"));
    if (fObj.dict.has("/DescendantFonts")) {
      for (const dfRef of extractAllRefs(fObj.dict.get("/DescendantFonts"))) {
        const dfObj = objects.get(dfRef);
        if (dfObj && dfObj.dict.has("/FontDescriptor")) checkDesc(dfObj.dict.get("/FontDescriptor"));
      }
    }
    if (hasEmbedded) embeddedFontFiles++;
  }

  // Collect fonts across all /Font objects and page /Resources
  for (const obj of objects.values()) {
    if (obj.dict.get("/Type") === "/Font") {
      inspectFontObj(obj, obj.objNum);
    }
  }
  for (const pg of pageObjs) {
    const resDict = pg.dict.has("/Resources") ? getDictFromToken(objects, pg.dict.get("/Resources")) : new Map();
    if (resDict.has("/Font")) {
      const fDict = getDictFromToken(objects, resDict.get("/Font"));
      for (const [fk, fv] of fDict.entries()) {
        const fObj = resolveObj(objects, fv);
        if (fObj) inspectFontObj(fObj, `${pg.objNum}_${fk}`);
      }
    }
  }

  // Inspect page content streams for BT/Tj text operators vs vector path operators
  let textOpCount = 0;
  let vectorPathOpCount = 0;
  let imageDrawOpCount = 0;
  const inspectedContentIds = new Set();

  for (const pg of pageObjs) {
    const cTok = pg.dict.get("/Contents");
    if (!cTok) continue;
    const contentRefs = extractAllRefs(cTok);
    for (const cref of contentRefs) {
      if (inspectedContentIds.has(cref)) continue;
      inspectedContentIds.add(cref);
      const cObj = objects.get(cref);
      if (!cObj || !cObj.streamBytes) continue;
      const flt = cObj.dict.get("/Filter") || "";
      const rawContent = flt.includes("/FlateDecode") ? await inflateFlate(cObj.streamBytes) : cObj.streamBytes;
      if (!rawContent) continue;
      const contentStr = bytesToLatin1(rawContent);
      const textMatches = contentStr.match(/(?:^|[\s)\]])(Tj|TJ|'|")(?=[\s\r\n]|$)/g);
      if (textMatches) textOpCount += textMatches.length;
      const pathMatches = contentStr.match(/(?:^|\s)\d+(?:\.\d+)?\s+\d+(?:\.\d+)?\s+(m|l|c|re)(?=\s|$)/g);
      if (pathMatches) vectorPathOpCount += pathMatches.length;
      const imgMatches = contentStr.match(/\/[A-Za-z0-9_.-]+\s+Do(?=\s|$)/g);
      if (imgMatches) imageDrawOpCount += imgMatches.length;
    }
  }

  const missingAltCount = figures.filter((f) => !f.hasAlt).length;
  const isLikelyOutlinedOrRaster = fontCount === 0 || textOpCount === 0;

  // Build deterministic ISO 14289-1 check list
  const checks = [
    {
      id: "pdfua_xmp_id",
      name: "PDF/UA-1 XMP Identifier (pdfuaid:part=1)",
      severity: "CRITICAL",
      status: hasPdfUaPart1 ? "PASS" : "FAIL",
      detail: hasPdfUaPart1
        ? "Found XMP pdfuaid:part=1 declaration in /Metadata stream."
        : "Missing XMP pdfuaid:part=1 identifier. Automated EU EAA / PAC / veraPDF validators immediately fail PDF/UA-1.",
    },
    {
      id: "mark_info",
      name: "Tagged PDF Flag (/MarkInfo /Marked true)",
      severity: "CRITICAL",
      status: isMarked && !hasSuspects ? "PASS" : "FAIL",
      detail: isMarked
        ? hasSuspects
          ? "/MarkInfo /Marked is true, but /Suspects is true (tagged structure flagged as unreliable)."
          : "Catalog declares /MarkInfo << /Marked true >> without suspects."
        : "Missing /MarkInfo << /Marked true >>. Assistive technology treats this file as an untagged document.",
    },
    {
      id: "struct_tree_root",
      name: "Semantic Structure Tree (/StructTreeRoot)",
      severity: "CRITICAL",
      status: hasStructTreeRoot && totalStructElems > 0 ? "PASS" : "FAIL",
      detail:
        hasStructTreeRoot && totalStructElems > 0
          ? `Found valid /StructTreeRoot with ${totalStructElems} semantic structure elements across ${Object.keys(tagCounts).length} tag types.`
          : "No /StructTreeRoot found (0 semantic tags). Screen readers have no headings, paragraphs, tables, or logical reading order.",
    },
    {
      id: "live_fonts_tounicode",
      name: "Live Embedded Fonts & /ToUnicode (Not Outlined Curves)",
      severity: "CRITICAL",
      status: !isLikelyOutlinedOrRaster && fontsWithToUnicode === fontCount ? "PASS" : isLikelyOutlinedOrRaster ? "FAIL" : "WARN",
      detail: isLikelyOutlinedOrRaster
        ? `Detected ${fontCount} fonts and ${textOpCount} text-draw operators (${vectorPathOpCount} vector path ops, ${imageDrawOpCount} image ops). Text appears outlined to vector paths or rasterized — the classic Figma export bug that breaks Adobe Acrobat Auto-Tag without OCR.`
        : fontsWithToUnicode === fontCount
          ? `Found ${fontCount} live fonts (${embeddedFontFiles} embedded font files), ${fontsWithToUnicode}/${fontCount} with /ToUnicode or standard encoding, and ${textOpCount} live text operators.`
          : `Found ${fontCount} fonts, but only ${fontsWithToUnicode}/${fontCount} have /ToUnicode CMap mappings (screen readers may read garbled glyphs).`,
    },
    {
      id: "document_lang",
      name: "Primary Document Language (/Lang)",
      severity: "CRITICAL",
      status: docLang.length >= 2 ? "PASS" : "FAIL",
      detail: docLang
        ? `Catalog sets /Lang "${docLang}" so screen readers load the correct pronunciation engine.`
        : "Missing /Lang entry in PDF Catalog. Required by ISO 14289-1 and WCAG 3.1.1.",
    },
    {
      id: "doc_title_display",
      name: "Document Title & DisplayDocTitle Preference",
      severity: "MAJOR",
      status: Boolean(docTitle) && displayDocTitle ? "PASS" : "FAIL",
      detail:
        docTitle && displayDocTitle
          ? `Title "${docTitle}" present and /ViewerPreferences /DisplayDocTitle is true.`
          : !docTitle && !displayDocTitle
            ? "Missing both document title (dc:title / /Title) and /ViewerPreferences /DisplayDocTitle true."
            : !docTitle
              ? "/DisplayDocTitle is true, but document title metadata is empty."
              : `Document title "${docTitle}" found, but /ViewerPreferences /DisplayDocTitle is not set to true.`,
    },
    {
      id: "figure_alt_text",
      name: "Alternative Text on /Figure Elements (/Alt)",
      severity: "CRITICAL",
      status: !hasStructTreeRoot
        ? "FAIL"
        : figures.length === 0
          ? "INFO"
          : missingAltCount === 0
            ? "PASS"
            : "FAIL",
      detail: !hasStructTreeRoot
        ? "Cannot verify figure Alt text because the PDF has no /StructTreeRoot."
        : figures.length === 0
          ? "No /Figure structure elements detected (verify manually that visual charts/images are either tagged as Figure+Alt or marked Artifact)."
          : missingAltCount === 0
            ? `All ${figures.length}/${figures.length} /Figure element(s) include non-empty /Alt descriptions.`
            : `${missingAltCount} of ${figures.length} /Figure element(s) are missing /Alt text (hard ISO 14289-1 failure).`,
    },
    {
      id: "heading_hierarchy",
      name: "Heading Hierarchy Integrity (No Skipped Levels)",
      severity: "MAJOR",
      status: !hasStructTreeRoot
        ? "FAIL"
        : headingsSequence.length === 0
          ? "WARN"
          : headingSkips.length === 0
            ? "PASS"
            : "FAIL",
      detail: !hasStructTreeRoot
        ? "0 headings found (untagged PDF)."
        : headingsSequence.length === 0
          ? "Tagged PDF contains 0 H1–H6 headings (consider adding semantic headings for screen-reader navigation)."
          : headingSkips.length === 0
            ? `Clean heading hierarchy (${headingsSequence.length} headings: ${headingsSequence.slice(0, 10).join(" → ")}${headingsSequence.length > 10 ? " …" : ""}).`
            : `Skipped heading level(s) detected: ${headingSkips.join(", ")} (violates ISO 14289-1 / Matterhorn 14-003).`,
    },
    {
      id: "table_headers",
      name: "Table Header Cells (/Table → /TH)",
      severity: "MAJOR",
      status: !hasStructTreeRoot
        ? "INFO"
        : tableCount === 0
          ? "INFO"
          : tablesWithTh === tableCount
            ? "PASS"
            : "FAIL",
      detail: !hasStructTreeRoot
        ? "Untagged PDF — any visual tables are invisible to screen readers."
        : tableCount === 0
          ? "No /Table elements found in structure tree."
          : tablesWithTh === tableCount
            ? `All ${tableCount}/${tableCount} /Table element(s) include semantic /TH header cells.`
            : `${tableCount - tablesWithTh} of ${tableCount} /Table element(s) lack /TH header cells.`,
    },
  ];

  const failedCount = checks.filter((c) => c.status === "FAIL").length;
  const warnCount = checks.filter((c) => c.status === "WARN").length;
  const passCount = checks.filter((c) => c.status === "PASS").length;

  let verdict = "PASS";
  if (failedCount > 0) verdict = "FAIL";
  else if (warnCount > 0) verdict = "WARN";

  return {
    ok: true,
    filename,
    fileSizeBytes: bytes.length,
    pdfVersion,
    pageCount,
    unpackedObjStmCount,
    detectedTool: detectedTool || "Not declared in metadata",
    verdict,
    summary: {
      pass: passCount,
      fail: failedCount,
      warn: warnCount,
      totalChecked: checks.filter((c) => c.status !== "INFO").length,
    },
    metrics: {
      docTitle: docTitle || null,
      docLang: docLang || null,
      hasPdfUaPart1,
      isMarked,
      displayDocTitle,
      totalStructElems,
      tagCounts,
      headingsSequence,
      headingSkips,
      figures,
      tableCount,
      tablesWithTh,
      fontCount,
      fontsWithToUnicode,
      embeddedFontFiles,
      textOpCount,
      vectorPathOpCount,
      imageDrawOpCount,
    },
    checks,
  };
}

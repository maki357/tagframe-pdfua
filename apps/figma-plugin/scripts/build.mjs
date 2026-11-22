/**
 * Zero-dependency bundler: combines `src/engine.mjs` + `src/code.js` into Figma's IIFE `dist/code.js`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const engineSrc = fs
  .readFileSync(path.join(root, "src", "engine.mjs"), "utf8")
  .replace(/^export\s+/gm, "");
const codeSrc = fs
  .readFileSync(path.join(root, "src", "code.js"), "utf8")
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["']\.\/engine\.mjs["'];?/m, "");

const bundle = `"use strict";\n(() => {\n${engineSrc}\n${codeSrc}\n})();\n`;
fs.mkdirSync(path.join(root, "dist"), { recursive: true });
fs.writeFileSync(path.join(root, "dist", "code.js"), bundle, "utf8");
console.log("Built Figma plugin bundle:", path.join(root, "dist", "code.js"), `(${bundle.length} bytes)`);

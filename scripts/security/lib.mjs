// scripts/security/lib.mjs — shared helpers for the security tooling (function matrix, RLS audit).
// Pure Node, zero dependencies, deterministic output (no timestamps, sorted keys).

import fs from "node:fs";
import path from "node:path";

/** Removes // and /* *\/ comments without touching string/template/regex-ish contents (best effort). */
export function stripComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      out += " ";
      continue;
    }
    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      out += c;
      i++;
      while (i < n) {
        const ch = src[i];
        out += ch;
        i++;
        if (ch === "\\" && i < n) { out += src[i]; i++; continue; }
        if (ch === q) break;
        if (q !== "`" && ch === "\n") break; // unterminated: bail out of the string
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

export function readText(file) {
  return fs.readFileSync(file, "utf8");
}

export function walk(dir, filter = () => true, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") walk(p, filter, acc); }
    else if (filter(p)) acc.push(p);
  }
  return acc;
}

export function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
  }
  return value;
}

export function posix(p) {
  return p.split(path.sep).join("/");
}

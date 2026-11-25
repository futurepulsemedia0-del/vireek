// scripts/notifications/scanTypes.mjs
// Static inventory of every notification `type` the codebase can emit. Used by
// supabase/functions/_shared/notify/soundTiers.test.mjs (fails when a type has no explicit tier)
// and to regenerate docs/notifications/sound-tiers.md. Heuristic by design: it reads source text,
// it does not run anything. Dynamic types are reported as `prefix*` entries.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function* walk(dir, exts) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "split") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p, exts);
    else if (exts.some((e) => name.endsWith(e)) && !/\.test\./.test(name)) yield p;
  }
}

const LITERAL = /^["'`]([a-z][a-z0-9_]*)["'`]$/;

/** @returns {{ types: Map<string, Set<string>>, dynamic: Map<string, Set<string>> }} */
export function scanNotificationTypes(root) {
  const types = new Map();
  const dynamic = new Map();
  const add = (map, key, file) => {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(file.replace(root + "/", ""));
  };
  const record = (raw, file) => {
    const v = raw.trim();
    const lit = LITERAL.exec(v);
    if (lit) return add(types, lit[1], file);
    const tpl = /^`([a-z][a-z0-9_]*_)\$\{/.exec(v);
    if (tpl) return add(dynamic, tpl[1], file);
  };

  // TypeScript producers: .from("notifications").insert({ ... type: "x" ... })
  for (const dir of ["supabase/functions", "src"]) {
    for (const file of walk(join(root, dir), [".ts", ".tsx"])) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((l, i) => {
        if (!/notifications["']\)\s*\.insert|notifications["']\)\s*$/.test(l) && !(l.includes("notifications") && /\.insert/.test(lines[i + 1] ?? ""))) return;
        const block = lines.slice(i, i + 25).join("\n");
        const m = /\btype\s*:\s*([^,\n}]+)/.exec(block);
        if (m) record(m[1], file);
      });
    }
  }
  // SQL: INSERT INTO notifications (cols) VALUES/SELECT … and _notify_owner(owner, 'type', …)
  const sqlRoot = join(root, "supabase/migrations");
  for (const file of walk(sqlRoot, [".sql"])) {
    const s = readFileSync(file, "utf8");
    for (const m of s.matchAll(/INSERT\s+INTO\s+(?:public\.)?notifications\s*\(([^)]*)\)\s*(?:VALUES|SELECT)\s*([\s\S]{0,1500})/gi)) {
      const cols = m[1].split(",").map((c) => c.trim().replace(/"/g, "").toLowerCase());
      const idx = cols.indexOf("type");
      if (idx < 0) continue;
      let body = m[2].trim().replace(/^\(/, "");
      const parts = []; let depth = 0, cur = "", q = false;
      for (const ch of body) {
        if (ch === "'") q = !q;
        if (!q) {
          if (ch === "(") depth++;
          if (ch === ")") { if (depth === 0) break; depth--; }
          if (ch === "," && depth === 0) { parts.push(cur.trim()); cur = ""; continue; }
        }
        cur += ch;
      }
      parts.push(cur.trim());
      const v = parts[idx];
      if (v && /^'[a-z][a-z0-9_]*'$/.test(v)) add(types, v.slice(1, -1), file);
    }
    for (const m of s.matchAll(/_notify_owner\(\s*[^,]+,\s*'([a-z][a-z0-9_]*)'/g)) add(types, m[1], file);
  }
  return { types, dynamic };
}

if (process.argv[1] && process.argv[1].endsWith("scanTypes.mjs")) {
  const { types, dynamic } = scanNotificationTypes(process.cwd());
  for (const t of [...types.keys()].sort()) console.log(t);
  for (const d of [...dynamic.keys()].sort()) console.log(d + "*");
}

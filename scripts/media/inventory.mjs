#!/usr/bin/env node
// Phase 0 — Image inventory (AST based, not regex).
//   node scripts/media/inventory.mjs                 -> prints summary, writes docs/media/image-inventory.{json,md}
//   node scripts/media/inventory.mjs --check         -> exits 1 if counts regress against scripts/media/image-baseline.json
//   node scripts/media/inventory.mjs --write-baseline
// TSX/JSX are parsed with the TypeScript compiler API (multi-line tags, spreads and expressions handled).
// HTML / Markdown / CSS use small quote-aware scanners (no regex tag matching).
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { extname, join, relative, resolve, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { FILLS, parentReserves, classAndStyleText } from './reserve.mjs'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const ROOT = process.cwd()
const SCAN_DIRS = ['src', 'public', 'content', 'index.html']
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-home', 'coverage', 'android', 'ios'])
const CODE_EXT = new Set(['.tsx', '.jsx'])
const HTML_EXT = new Set(['.html'])
const MD_EXT = new Set(['.md', '.mdx'])
const CSS_EXT = new Set(['.css'])
const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg'])
const ABOVE_FOLD_HINTS = ['components/Header', 'components/Hero', 'sections/Hero', 'pages/HomePage', 'components/auth/AuthParts']

const walk = (p) => {
  if (!existsSync(p)) return []
  const st = statSync(p)
  if (st.isFile()) return [p]
  return readdirSync(p).flatMap((n) => (SKIP_DIRS.has(n) ? [] : walk(join(p, n))))
}
const rel = (f) => relative(ROOT, f).replaceAll('\\', '/')

// ---------- helpers ----------
const fileInfo = (src) => {
  if (!src || /^(data:|https?:|blob:)/.test(src)) return { local: false }
  const clean = src.split('?')[0].split('#')[0]
  const cand = [join(ROOT, 'public', clean), join(ROOT, clean.replace(/^\//, ''))]
  const hit = cand.find((c) => existsSync(c) && statSync(c).isFile())
  return hit ? { local: true, bytes: statSync(hit).size, format: extname(hit).slice(1).toLowerCase() } : { local: true, missing: true }
}
const formatOf = (src) => (src && !/^data:/.test(src) ? extname(src.split('?')[0]).slice(1).toLowerCase() || 'unknown' : src ? 'data-uri' : 'dynamic')

const jsxName = (n) => n.tagName.getText()
const clsText = classAndStyleText
const attrMap = (el, sf) => {
  const map = new Map()
  let spread = false
  for (const a of el.attributes.properties) {
    if (ts.isJsxSpreadAttribute(a)) { spread = true; continue }
    const name = a.name.getText(sf)
    const init = a.initializer
    let kind = 'true'
    let value
    if (init) {
      if (ts.isStringLiteral(init)) { kind = 'string'; value = init.text }
      else if (ts.isJsxExpression(init) && init.expression) {
        const e = init.expression
        if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) { kind = 'string'; value = e.text }
        else { kind = 'expr'; value = e.getText(sf) }
      } else kind = 'expr'
    }
    map.set(name, { kind, value })
  }
  return { map, spread }
}
const altState = (m, spread, ariaHidden) => {
  const a = m.get('alt')
  if (!a) return spread ? 'spread-unknown' : ariaHidden ? 'missing-but-aria-hidden' : 'missing'
  if (a.kind === 'string') return a.value.trim() === '' ? 'empty' : 'descriptive-static'
  if (a.kind === 'expr') return /^t\(|\bt\(/.test(a.value) ? 'descriptive-i18n' : 'dynamic'
  return 'invalid'
}

// ---------- TSX/JSX ----------
const entries = []
const push = (e) => entries.push(e)

function scanCode(file) {
  const text = readFileSync(file, 'utf8')
  if (!/<(img|motion\.img|picture|svg|source)\b|backgroundImage|bg-\[url|<Img\b|<RevealImage/.test(text) && !/background/i.test(text)) return
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const where = rel(file)
  const lineOf = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
  const above = ABOVE_FOLD_HINTS.some((h) => where.includes(h))
  const visit = (node) => {
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const name = jsxName(node)
      const { map, spread } = attrMap(node, sf)
      const ariaHidden = map.get('aria-hidden')?.value === 'true' || map.get('aria-hidden')?.kind === 'true'
      if (name === 'img' || name === 'motion.img' || name === 'Img') {
        const src = map.get('src')
        const srcStr = src?.kind === 'string' ? src.value : undefined
        const info = fileInfo(srcStr)
        const alt = altState(map, spread, ariaHidden)
        push({
          kind: name === 'Img' ? 'Img-component' : 'img', file: where, line: lineOf(node), src: srcStr ?? (src ? `{${src.value}}` : null),
          alt, role: alt === 'empty' || ariaHidden ? 'decorative' : 'content',
          width: map.has('width') && map.has('height') ? 'both' : /\baspect-/.test(clsText(node, sf)) || /aspectRatio/.test(clsText(node, sf)) ? 'aspect-ratio' : FILLS(clsText(node, sf)) && parentReserves(node, sf) ? 'reserved-by-parent' : map.has('width') || map.has('height') ? 'partial' : 'none',
          loading: map.get('loading')?.value ?? null, decoding: map.get('decoding')?.value ?? null,
          fetchpriority: (map.get('fetchPriority') ?? map.get('fetchpriority'))?.value ?? null,
          srcset: map.has('srcSet') || map.has('srcset'), sizes: map.has('sizes'),
          format: formatOf(srcStr), bytes: info.bytes ?? null, fileMissing: Boolean(info.missing), fold: above ? 'above(heuristic)' : 'unknown/below', spread,
        })
      } else if (name === 'picture') {
        push({ kind: 'picture', file: where, line: lineOf(node), alt: 'n/a', role: 'container' })
      } else if (name === 'RevealImage') {
        const nm = map.get('name')
        push({ kind: 'RevealImage', file: where, line: lineOf(node), src: nm?.value ?? null, alt: altState(map, spread, false), role: 'content', priority: map.has('priority'), fold: map.has('priority') ? 'above' : 'below(heuristic)' })
      } else if (name === 'svg') {
        const role = map.get('role')?.value
        const hidden = ariaHidden
        const labelled = map.has('aria-label') || map.has('aria-labelledby')
        // Inline SVG counts as *content* only when it is exposed to AT (role=img / labelled) or has no aria-hidden and sits outside lucide wrappers.
        push({ kind: 'inline-svg', file: where, line: lineOf(node), alt: role === 'img' ? (labelled ? 'labelled' : 'role-img-unlabelled') : hidden ? 'aria-hidden' : labelled ? 'labelled' : 'unmarked', role: hidden ? 'decorative' : role === 'img' || labelled ? 'content' : 'unclassified', width: map.has('width') || map.has('viewBox') ? 'both' : 'none' })
      }
      // CSS background via style prop
      const style = map.get('style')
      if (style?.kind === 'expr' && /backgroundImage|background:/.test(style.value) && /url\(/.test(style.value)) push({ kind: 'css-background-inline', file: where, line: lineOf(node), alt: 'n/a', role: 'unclassified', src: style.value.slice(0, 80) })
      const cls = map.get('className')
      if (cls?.value && /bg-\[url\(/.test(cls.value)) push({ kind: 'css-background-tailwind', file: where, line: lineOf(node), alt: 'n/a', role: 'unclassified', src: cls.value.match(/bg-\[url\([^\]]*\]/)?.[0] ?? null })
    }
    // new Image() / backgroundImage in object literals outside JSX
    if (ts.isPropertyAssignment(node) && node.name.getText(sf) === 'backgroundImage' && /url\(/.test(node.initializer.getText(sf)) && !ts.isJsxAttribute(node.parent?.parent ?? node)) {
      push({ kind: 'css-background-object', file: where, line: lineOf(node), alt: 'n/a', role: 'unclassified', src: node.initializer.getText(sf).slice(0, 80) })
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
}

// ---------- HTML / Markdown / CSS scanners ----------
function scanHtmlTags(text) {
  // Quote-aware tag scanner: yields {name, attrs, offset}. Skips comments/script/style bodies.
  const out = []
  let i = 0
  while (i < text.length) {
    if (text.startsWith('<!--', i)) { i = text.indexOf('-->', i); if (i < 0) break; i += 3; continue }
    if (text[i] !== '<' || !/[a-zA-Z]/.test(text[i + 1] ?? '')) { i++; continue }
    let j = i + 1
    while (j < text.length && /[A-Za-z0-9:-]/.test(text[j])) j++
    const name = text.slice(i + 1, j).toLowerCase()
    const attrs = new Map()
    while (j < text.length && text[j] !== '>') {
      while (/\s|\//.test(text[j] ?? '')) j++
      let k = j
      while (k < text.length && !/[\s=>/]/.test(text[k])) k++
      const an = text.slice(j, k).toLowerCase()
      j = k
      while (/\s/.test(text[j] ?? '')) j++
      let val = true
      if (text[j] === '=') {
        j++
        while (/\s/.test(text[j] ?? '')) j++
        if (text[j] === '"' || text[j] === "'") { const q = text[j]; const e = text.indexOf(q, j + 1); val = text.slice(j + 1, e < 0 ? text.length : e); j = (e < 0 ? text.length : e) + 1 }
        else { k = j; while (k < text.length && !/[\s>]/.test(text[k])) k++; val = text.slice(j, k); j = k }
      }
      if (an) attrs.set(an, val)
    }
    out.push({ name, attrs, offset: i })
    if ((name === 'script' || name === 'style')) { const e = text.indexOf(`</${name}`, j); if (e > 0) j = e }
    i = j + 1
  }
  return out
}
const lineAt = (text, off) => text.slice(0, off).split('\n').length
function scanHtml(file) {
  const text = readFileSync(file, 'utf8')
  for (const t of scanHtmlTags(text)) {
    if (t.name === 'img') {
      const src = typeof t.attrs.get('src') === 'string' ? t.attrs.get('src') : null
      const info = fileInfo(src)
      const alt = !t.attrs.has('alt') ? 'missing' : String(t.attrs.get('alt')).trim() === '' ? 'empty' : 'descriptive-static'
      push({ kind: 'img(html)', file: rel(file), line: lineAt(text, t.offset), src, alt, role: alt === 'empty' ? 'decorative' : 'content', width: t.attrs.has('width') && t.attrs.has('height') ? 'both' : 'none', loading: t.attrs.get('loading') ?? null, fetchpriority: t.attrs.get('fetchpriority') ?? null, srcset: t.attrs.has('srcset'), sizes: t.attrs.has('sizes'), format: formatOf(src), bytes: info.bytes ?? null, fileMissing: Boolean(info.missing), fold: 'unknown' })
    }
    if (t.name === 'picture') push({ kind: 'picture(html)', file: rel(file), line: lineAt(text, t.offset), alt: 'n/a', role: 'container' })
    if (t.name === 'svg') push({ kind: 'inline-svg(html)', file: rel(file), line: lineAt(text, t.offset), alt: t.attrs.get('aria-hidden') === 'true' ? 'aria-hidden' : t.attrs.has('aria-label') ? 'labelled' : 'unmarked', role: 'unclassified' })
  }
}
function scanMarkdown(file) {
  // Markdown images: ![alt](src "title"). Fenced code blocks are skipped. HTML <img> inside MD is delegated to scanHtml.
  const text = readFileSync(file, 'utf8')
  let inFence = false
  let off = 0
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('```')) inFence = !inFence
    if (!inFence) {
      let i = line.indexOf('![')
      while (i >= 0) {
        const close = line.indexOf('](', i)
        const end = close < 0 ? -1 : line.indexOf(')', close)
        if (close > 0 && end > 0) {
          const alt = line.slice(i + 2, close).trim()
          const src = line.slice(close + 2, end).trim().split(/\s+/)[0]
          const info = fileInfo(src)
          push({ kind: 'img(markdown)', file: rel(file), line: lineAt(text, off), src, alt: alt === '' ? 'empty' : 'descriptive-static', role: alt === '' ? 'decorative?' : 'content', width: 'none', loading: null, fetchpriority: null, srcset: false, sizes: false, format: formatOf(src), bytes: info.bytes ?? null, fold: 'below' })
        }
        i = line.indexOf('![', i + 2)
      }
    }
    off += line.length + 1
  }
  if (text.includes('<img')) scanHtml(file)
}
function scanCss(file) {
  const text = readFileSync(file, 'utf8')
  let i = text.indexOf('url(')
  while (i >= 0) {
    const e = text.indexOf(')', i)
    const raw = text.slice(i + 4, e).trim().replace(/^['"]|['"]$/g, '')
    const ctxStart = text.lastIndexOf('\n', i)
    if (/background/.test(text.slice(ctxStart, i)) && !/^data:image\/svg/.test(raw) && !/^#/.test(raw)) {
      const info = fileInfo(raw)
      push({ kind: 'css-background', file: rel(file), line: lineAt(text, i), src: raw.slice(0, 100), alt: 'n/a', role: 'unclassified', format: formatOf(raw), bytes: info.bytes ?? null })
    }
    i = text.indexOf('url(', e)
  }
}

for (const d of SCAN_DIRS) {
  for (const f of walk(resolve(ROOT, d))) {
    const ext = extname(f).toLowerCase()
    if (CODE_EXT.has(ext) && !/\.test\.|ui\/Img\.tsx$/.test(f.replaceAll('\\', '/'))) scanCode(f)
    else if (HTML_EXT.has(ext)) scanHtml(f)
    else if (MD_EXT.has(ext)) scanMarkdown(f)
    else if (CSS_EXT.has(ext)) scanCss(f)
  }
}

// ---------- static asset catalogue ----------
const assets = walk(resolve(ROOT, 'public')).filter((f) => IMG_EXT.has(extname(f).toLowerCase())).map((f) => ({ path: rel(f), bytes: statSync(f).size }))
const referenced = new Set(entries.map((e) => e.src).filter(Boolean).map(String))
const sourceBlob = SCAN_DIRS.flatMap((d) => walk(resolve(ROOT, d))).filter((f) => /\.(tsx?|jsx?|html|css|md|json|webmanifest)$/.test(f)).map((f) => readFileSync(f, 'utf8')).join('\n')
const unusedAssets = assets.filter((a) => !sourceBlob.includes(a.path.replace(/^public\//, '')) && !sourceBlob.includes(a.path.split('/').pop().replace(/\.[^.]+$/, '')))

// ---------- summary ----------
// <Img> usages are compile-time guaranteed (alt/decorative + size) and counted separately.
const imgs = entries.filter((e) => ['img', 'img(html)', 'img(markdown)'].includes(e.kind))
const count = (arr, f) => arr.filter(f).length
const summary = {
  generatedAt: new Date().toISOString(),
  totals: {
    img: imgs.length, imgComponent: entries.filter((e) => e.kind === 'Img-component').length, picture: count(entries, (e) => e.kind.startsWith('picture')), revealImage: count(entries, (e) => e.kind === 'RevealImage'),
    inlineSvg: count(entries, (e) => e.kind.startsWith('inline-svg')), cssBackground: count(entries, (e) => e.kind.startsWith('css-background')),
  },
  img: {
    altMissing: count(imgs, (e) => e.alt === 'missing'), altSpreadUnknown: count(imgs, (e) => e.alt === 'spread-unknown'), altEmpty: count(imgs, (e) => e.alt === 'empty'),
    altDescriptive: count(imgs, (e) => /^descriptive/.test(e.alt)), altDynamic: count(imgs, (e) => e.alt === 'dynamic'),
    noDimensions: count(imgs, (e) => !['both', 'aspect-ratio', 'reserved-by-parent'].includes(e.width)), noLoading: count(imgs, (e) => !e.loading), noDecoding: count(imgs, (e) => !e.decoding),
    noSrcset: count(imgs, (e) => !e.srcset), nonModernLocal: count(imgs, (e) => e.bytes != null && ['png', 'jpg', 'jpeg', 'gif'].includes(e.format)),
  },
  inlineSvgUnclassified: count(entries, (e) => e.kind.startsWith('inline-svg') && e.role === 'unclassified'),
  inlineSvgRoleImgUnlabelled: count(entries, (e) => e.alt === 'role-img-unlabelled'),
  assets: { count: assets.length, totalBytes: assets.reduce((s, a) => s + a.bytes, 0), over200KB: assets.filter((a) => a.bytes > 200 * 1024).map((a) => a.path), unused: unusedAssets.map((a) => a.path) },
}

const args = new Set(process.argv.slice(2))
const outDir = join(ROOT, 'docs/media')
mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'image-inventory.json'), JSON.stringify({ summary, entries, assets }, null, 2) + '\n')
const top = (n, f) => entries.filter(f).slice(0, n).map((e) => `- \`${e.file}:${e.line}\` (${e.kind}, alt=${e.alt}, dims=${e.width ?? '-'}, loading=${e.loading ?? '-'})`).join('\n')
writeFileSync(join(outDir, 'image-inventory.md'), `# Image inventory (generated)\n\nRun \`node scripts/media/inventory.mjs\`. AST-based for TSX/JSX.\n\n\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\`\n\n## <img> without alt\n${top(500, (e) => e.alt === 'missing') || '_none_'}\n\n## <img> without both width and height\n${top(500, (e) => imgs.includes(e) && !['both', 'aspect-ratio', 'reserved-by-parent'].includes(e.width)) || '_none_'}\n\n## <img> without loading\n${top(500, (e) => imgs.includes(e) && !e.loading) || '_none_'}\n`)
console.log(JSON.stringify(summary, null, 2))

const baselinePath = join(ROOT, 'scripts/media/image-baseline.json')
const metric = (s) => ({ altMissing: s.img.altMissing, noDimensions: s.img.noDimensions, noLoading: s.img.noLoading, roleImgUnlabelled: s.inlineSvgRoleImgUnlabelled })
if (args.has('--write-baseline')) { writeFileSync(baselinePath, JSON.stringify(metric(summary), null, 2) + '\n'); console.log('baseline written') }
if (args.has('--check')) {
  const base = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : { altMissing: 0, noDimensions: 0, noLoading: 0, roleImgUnlabelled: 0 }
  const cur = metric(summary)
  const bad = Object.keys(cur).filter((k) => cur[k] > base[k])
  if (bad.length) { for (const k of bad) console.error(`::error title=Image inventory::${k} regressed ${base[k]} -> ${cur[k]}`); process.exit(1) }
  console.log('image inventory ratchet OK')
}

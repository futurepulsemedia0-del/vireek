#!/usr/bin/env node
// AST codemod for raw <img>/<motion.img>. DRY-RUN by default.
//   node scripts/media/codemod-img.mjs            -> report only
//   node scripts/media/codemod-img.mjs --write    -> apply safe edits
// Safe edits only:
//   * add decoding="async" when missing
//   * add loading="lazy" when no loading AND no fetchPriority="high" AND file is not on the above-the-fold list
//   * add width/height from the real file when `src` is a static local path (needs `sharp`)
// Never guesses: images with dynamic src and no reserved space are listed under MANUAL.
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { join, extname, relative } from 'node:path'
import { createRequire } from 'node:module'
import { FILLS, parentReserves, classAndStyleText } from './reserve.mjs'

const require = createRequire(import.meta.url)
const ts = require('typescript')
let sharp = null
try { sharp = require('sharp') } catch { /* optional */ }
const WRITE = process.argv.includes('--write')
const ABOVE = ['components/Header', 'components/auth/AuthParts']
const walk = (p) => (statSync(p).isFile() ? [p] : readdirSync(p).flatMap((n) => (n === 'node_modules' ? [] : walk(join(p, n)))))
const stats = { files: 0, loading: 0, decoding: 0, dims: 0, manual: [] }

const nm = (n) => n.tagName.getText()
for (const file of walk('src').filter((f) => /\.(tsx|jsx)$/.test(f) && !/\.test\./.test(f) && !f.endsWith('ui/Img.tsx') && !f.endsWith('ui/RevealImage.tsx'))) {
  const text = readFileSync(file, 'utf8')
  if (!/<(motion\.)?img\b/.test(text)) continue
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const edits = []
  const above = ABOVE.some((a) => file.replaceAll('\\', '/').includes(a))
  const visit = (node) => {
    if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && ['img', 'motion.img'].includes(nm(node))) {
      const attrs = new Map(node.attributes.properties.filter(ts.isJsxAttribute).map((a) => [a.name.getText(sf), a]))
      if (node.attributes.properties.some(ts.isJsxSpreadAttribute)) return
      const at = node.tagName.end
      const add = []
      const fpHigh = /high/.test(attrs.get('fetchPriority')?.initializer?.getText(sf) ?? '')
      if (!attrs.has('loading') && !fpHigh && !above) { add.push('loading="lazy"'); stats.loading++ }
      if (!attrs.has('decoding')) { add.push('decoding="async"'); stats.decoding++ }
      const cls = classAndStyleText(node, sf)
      const reserved = (attrs.has('width') && attrs.has('height')) || /\baspect-/.test(cls) || /aspectRatio/.test(attrs.get('style')?.initializer?.getText(sf) ?? '')
      const byParent = !reserved && FILLS(cls) && parentReserves(node, sf)
      if (!reserved && !byParent) {
        const src = attrs.get('src')?.initializer
        const lit = src && ts.isStringLiteral(src) ? src.text : null
        const path = lit && lit.startsWith('/') ? join('public', lit) : null
        if (path && sharp && existsSync(path) && extname(path) !== '.svg') {
          // sync metadata is not available in sharp; defer via marker resolved below
          add.push({ dims: path })
        } else if (path && existsSync(path) && extname(path) === '.svg') {
          const m = readFileSync(path, 'utf8').match(/viewBox="[\d.\-]+\s+[\d.\-]+\s+([\d.]+)\s+([\d.]+)"/)
          if (m) { add.push(`width={${Math.round(+m[1])}} height={${Math.round(+m[2])}}`); stats.dims++ }
          else stats.manual.push(`${relative('.', file)}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`)
        } else stats.manual.push(`${relative('.', file)}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`)
      }
      if (add.length) edits.push({ at, add })
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  if (!edits.length) continue
  stats.files++
  let out = text
  for (const e of edits.sort((a, b) => b.at - a.at)) {
    const parts = []
    for (const a of e.add) {
      if (typeof a === 'string') parts.push(a)
      else {
        const m = await sharp(a.dims).metadata()
        parts.push(`width={${m.width}} height={${m.height}}`); stats.dims++
      }
    }
    out = out.slice(0, e.at) + ' ' + parts.join(' ') + out.slice(e.at)
  }
  if (WRITE) writeFileSync(file, out)
}
console.log(JSON.stringify({ mode: WRITE ? 'write' : 'dry-run', filesTouched: stats.files, addedLoading: stats.loading, addedDecoding: stats.decoding, addedDimensions: stats.dims, manualRemaining: stats.manual.length }, null, 2))
if (stats.manual.length) console.log('MANUAL (no safe dimension source — use <Img aspectRatio> or add aspect-* / width+height):\n' + stats.manual.join('\n'))

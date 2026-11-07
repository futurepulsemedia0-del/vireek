#!/usr/bin/env node
// Phase-2 codemod (AST). DRY-RUN by default; `--write` applies. Idempotent. Run AFTER codemod-img.mjs.
//  1. <img> still without reserved space -> style={{ aspectRatio: 'auto R' }}.
//     `auto R` reserves the box R before load and switches to the file's real ratio after load.
//     R is a heuristic (logo 4 / 1, avatar/QR/signature 1 / 1, else 4 / 3): review visually.
//  2. Inline <svg> with no aria-hidden / role / aria-label / <title> -> aria-hidden="true" focusable="false".
//  3. Static English alt="…" listed in ALT_KEYS -> alt={t('images.<key>')} (adds useTranslation to the
//     enclosing component when needed). Brand-name alts (Vireek logos) are intentionally untouched.
// Anything it cannot change safely is printed under MANUAL.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createRequire } from 'node:module'
import { isReserved, classAndStyleText } from './reserve.mjs'

const ts = createRequire(import.meta.url)('typescript')
const WRITE = process.argv.includes('--write')

const ALT_KEYS = {
  'Field photo': 'fieldPhoto', 'Customer signature': 'customerSignature', 'Job photo': 'jobPhoto', 'Job photo, full size': 'jobPhotoFull',
  'Selected equipment': 'selectedEquipment', 'QR code that opens this quote on your phone': 'quoteQr', 'Booking QR code': 'bookingQr',
  'Shared photo': 'sharedPhoto', 'Scan to pay': 'scanToPay', 'QR code for the wallet link': 'walletQr', 'Preview of the public card': 'cardPreview',
  'Receipt preview': 'receiptPreview', Defect: 'defect', Before: 'before', After: 'after', 'Captured view': 'capturedView', '2FA QR code': 'twoFaQr',
  'QR code to open this page on your phone': 'pageQr', 'Customer screenshot': 'customerScreenshot', 'Defect photo': 'defectPhoto',
}

const walk = (p) => (statSync(p).isFile() ? [p] : readdirSync(p).flatMap((n) => (n === 'node_modules' ? [] : walk(join(p, n)))))
const stat = { aspect: 0, svg: 0, alt: 0, hooks: 0, manual: [] }

const ratioFor = (src, cls) => {
  const s = `${src} ${cls}`.toLowerCase()
  if (/logo|wordmark|brand/.test(s)) return '4 / 1'
  if (/rounded-full|qr|signature|avatar/.test(s)) return '1 / 1'
  return '4 / 3'
}
const enclosingComponent = (node) => {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isFunctionDeclaration(n) && n.name && /^[A-Z]/.test(n.name.text) && n.body) return n
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && /^[A-Z]/.test(n.name.text) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer)) && ts.isBlock(n.initializer.body)) return n.initializer
  }
  return null
}

for (const file of walk('src').filter((f) => /\.tsx$/.test(f) && !/\.test\./.test(f) && !/ui[\\/]Img\.tsx$/.test(f))) {
  const text = readFileSync(file, 'utf8')
  if (!/<(motion\.)?img\b|<svg\b/.test(text)) continue
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  if (sf.parseDiagnostics.length) { stat.manual.push(`${relative('.', file)}: skipped (file does not parse)`); continue }
  const where = (n) => `${relative('.', file)}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`
  const edits = []
  const needsT = []

  const visit = (node) => {
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const name = node.tagName.getText(sf)
      const attrs = new Map(node.attributes.properties.filter(ts.isJsxAttribute).map((a) => [a.name.getText(sf), a]))
      const spread = node.attributes.properties.some(ts.isJsxSpreadAttribute)
      if ((name === 'img' || name === 'motion.img') && !spread) {
        if (!isReserved(node, sf, attrs)) {
          const st = attrs.get('style')?.initializer
          const lit = st && ts.isJsxExpression(st) && st.expression && ts.isObjectLiteralExpression(st.expression) ? st.expression : null
          if (attrs.has('style') && !lit) stat.manual.push(`${where(node)}: style prop is not an object literal — add aspectRatio by hand`)
          else if (lit) {
            const src = attrs.get('src')?.initializer?.getText(sf) ?? ''
            edits.push({ at: lit.getStart(sf) + 1, del: 0, text: ` aspectRatio: 'auto ${ratioFor(src, classAndStyleText(node, sf))}',` })
            stat.aspect++
          } else {
            const src = attrs.get('src')?.initializer?.getText(sf) ?? ''
            edits.push({ at: node.tagName.end, del: 0, text: ` style={{ aspectRatio: 'auto ${ratioFor(src, classAndStyleText(node, sf))}' }}` })
            stat.aspect++
          }
        }
        const alt = attrs.get('alt')
        if (alt?.initializer && ts.isStringLiteral(alt.initializer) && ALT_KEYS[alt.initializer.text]) {
          const comp = enclosingComponent(node)
          if (!comp) stat.manual.push(`${where(node)}: alt "${alt.initializer.text}" not inside a component — translate by hand`)
          else {
            needsT.push({ comp, at: alt.initializer.getStart(sf), del: alt.initializer.getWidth(sf), key: ALT_KEYS[alt.initializer.text] })
            stat.alt++
          }
        }
      }
      if (name === 'svg') {
        const marked = ['aria-hidden', 'role', 'aria-label', 'aria-labelledby'].some((k) => attrs.has(k))
        const hasTitle = ts.isJsxOpeningElement(node) && node.parent.children.some((c) => (ts.isJsxElement(c) && c.openingElement.tagName.getText(sf) === 'title'))
        if (!marked && !hasTitle && !spread) { edits.push({ at: node.tagName.end, del: 0, text: ' aria-hidden="true" focusable="false"' }); stat.svg++ }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)

  // Decide which translate function each component uses: its own `t` from useTranslation, a fresh `t`,
  // or an alias `tImg` when a different `t` is already declared inside the component (e.g. a timer handle).
  const fnFor = new Map()
  for (const comp of new Set(needsT.map((n) => n.comp))) {
    const body = comp.body.getText(sf)
    if (/const\s*\{[^}]*\bt\b[^}]*\}\s*=\s*useTranslation\(/.test(body)) { fnFor.set(comp, 't'); continue }
    const conflict = /\b(const|let|var)\s+t\b|\{[^}]*\bt\b[^}]*\}\s*=/.test(body) || /\(\s*t\b|,\s*t\s*[,)]/.test(comp.getText(sf).slice(0, comp.getText(sf).indexOf('{')))
    const name = conflict ? 'tImg' : 't'
    edits.push({ at: comp.body.getStart(sf) + 1, del: 0, text: `\n  const { t${conflict ? ': tImg' : ''} } = useTranslation();` })
    fnFor.set(comp, name)
    stat.hooks++
  }
  for (const n of needsT) edits.push({ at: n.at, del: n.del, text: `{${fnFor.get(n.comp)}('images.${n.key}')}` })
  const usesAlt = needsT.length > 0
  if (usesAlt && !/from 'react-i18next'/.test(text)) {
    const imports = sf.statements.filter(ts.isImportDeclaration)
    edits.push({ at: imports[imports.length - 1].end, del: 0, text: "\nimport { useTranslation } from 'react-i18next';" })
  } else if (usesAlt && !/useTranslation[^;]*from 'react-i18next'/.test(text)) {
    stat.manual.push(`${relative('.', file)}: imports react-i18next without useTranslation — add the import by hand`)
  }
  if (!edits.length) continue
  let out = text
  for (const e of edits.sort((a, b) => b.at - a.at)) out = out.slice(0, e.at) + e.text + out.slice(e.at + e.del)
  if (WRITE) writeFileSync(file, out)
}
console.log(JSON.stringify({ mode: WRITE ? 'write' : 'dry-run', aspectRatioAdded: stat.aspect, svgMarkedDecorative: stat.svg, altsTranslated: stat.alt, hooksInserted: stat.hooks, manual: stat.manual.length }, null, 2))
if (stat.manual.length) console.log('MANUAL:\n' + stat.manual.join('\n'))

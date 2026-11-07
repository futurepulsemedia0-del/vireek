// Shared TypeScript-AST helpers: does an <img> reserve layout space through its own box or an ancestor?
// Used by inventory.mjs and the codemods. Mirrors eslint-rules/vireek-img.mjs (which works on ESTree nodes).
import { createRequire } from 'node:module'
const ts = createRequire(import.meta.url)('typescript')

export const FILLS = (c) => (/\bh-full\b/.test(c) && /\bw-full\b/.test(c)) || /\binset-0\b/.test(c)
export const SIZED = (c) => /\baspect-|aspectRatio/.test(c) || (/\b(h|size|min-h)-(\d|\[)/.test(c) && !/\bh-full\b/.test(c))

export const classAndStyleText = (el, sf) =>
  el.attributes.properties
    .filter(ts.isJsxAttribute)
    .filter((x) => ['className', 'style'].includes(x.name.getText(sf)))
    .map((x) => x.initializer?.getText(sf) ?? '')
    .join(' ')

/** `node` is the img's JsxSelfClosingElement / JsxOpeningElement. */
export function parentReserves(node, sf) {
  let el = ts.isJsxOpeningElement(node) ? node.parent.parent : node.parent
  for (let i = 0; i < 3 && el; i++) {
    let host = el.parent
    while (host && !ts.isJsxElement(host)) {
      host = host.parent && (ts.isJsxExpression(host) || ts.isParenthesizedExpression(host) || ts.isConditionalExpression(host) || ts.isBinaryExpression(host) || ts.isArrowFunction(host) || ts.isCallExpression(host) || ts.isReturnStatement(host) || ts.isBlock(host)) ? host.parent : undefined
    }
    if (!host) return false
    if (SIZED(classAndStyleText(host.openingElement, sf))) return true
    el = host
  }
  return false
}

export const isReserved = (node, sf, attrs) => {
  const cls = classAndStyleText(node, sf)
  if (attrs.has('width') && attrs.has('height')) return true
  if (/\baspect-|aspectRatio/.test(cls)) return true
  return FILLS(cls) && parentReserves(node, sf)
}

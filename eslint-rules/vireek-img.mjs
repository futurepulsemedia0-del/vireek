// Local ESLint plugin: image policy for Vireek.
//  vireek-img/policy — every <img> / <motion.img> must (a) declare its loading policy and
//  (b) reserve space (width+height, or an aspect-* class, or style.aspectRatio).
//  Prefer <Img> from '@/components/ui/Img' which enforces both at compile time.
const NAMES = new Set(['img', 'motion.img'])

const nameOf = (n) => (n.type === 'JSXIdentifier' ? n.name : n.type === 'JSXMemberExpression' ? `${nameOf(n.object)}.${n.property.name}` : '')
const attr = (el, name) => el.attributes.find((a) => a.type === 'JSXAttribute' && a.name.name === name)
const hasSpread = (el) => el.attributes.some((a) => a.type === 'JSXSpreadAttribute')
const staticText = (a) => {
  if (!a || !a.value) return ''
  if (a.value.type === 'Literal') return String(a.value.value)
  if (a.value.type === 'JSXExpressionContainer') {
    const e = a.value.expression
    if (e.type === 'Literal') return String(e.value)
    if (e.type === 'TemplateLiteral') return e.quasis.map((q) => q.value.raw).join(' ')
    // className={cn('a', cond && 'b')} — collect any string literal
    return JSON.stringify(e, (k, v) => (k === 'parent' ? undefined : v))
  }
  return ''
}

const FILLS = (c) => /\bh-full\b/.test(c) && /\bw-full\b/.test(c) || /\binset-0\b/.test(c)
const SIZED = (c) => /\baspect-/.test(c) || /\b(h|size|min-h)-(\d|\[)/.test(c) && !/\bh-full\b/.test(c)
// An image that fills its parent (h-full w-full / absolute inset-0) reserves space through that ancestor box.
const parentReserves = (node) => {
  let el = node.parent && node.parent.parent // JSXElement of the img
  for (let i = 0; i < 3 && el; i++) {
    const host = el.parent
    if (!host || host.type !== 'JSXElement') return false
    const c = staticText(attr(host.openingElement, 'className')) + staticText(attr(host.openingElement, 'style'))
    if (SIZED(c) || /aspectRatio/.test(c)) return true
    el = host
  }
  return false
}

export default {
  meta: { name: 'vireek-img' },
  rules: {
    policy: {
      meta: {
        type: 'problem',
        schema: [],
        messages: {
          loading: 'Declare a loading policy: loading="lazy" (default) or, for the single LCP image, loading="eager" with fetchPriority="high". Prefer <Img>.',
          decoding: 'Add decoding="async" (or use <Img>).',
          dims: 'Reserve space: set width AND height, an aspect-* class, or style={{ aspectRatio }} (or use <Img>).',
          lcp: 'fetchPriority="high" must be paired with loading="eager" (LCP image only).',
        },
      },
      create(context) {
        return {
          JSXOpeningElement(node) {
            if (!NAMES.has(nameOf(node.name)) || hasSpread(node)) return
            const loading = attr(node, 'loading')
            const fp = attr(node, 'fetchPriority')
            const high = fp && /high/.test(staticText(fp))
            if (!loading) context.report({ node, messageId: 'loading' })
            else if (high && !/eager/.test(staticText(loading))) context.report({ node, messageId: 'lcp' })
            if (!attr(node, 'decoding')) context.report({ node, messageId: 'decoding' })
            const dims = attr(node, 'width') && attr(node, 'height')
            const aspect = /\baspect-/.test(staticText(attr(node, 'className'))) || /aspectRatio/.test(staticText(attr(node, 'style')))
            const fills = FILLS(staticText(attr(node, 'className')))
            if (!dims && !aspect && !(fills && parentReserves(node))) context.report({ node, messageId: 'dims' })
          },
        }
      },
    },
  },
}

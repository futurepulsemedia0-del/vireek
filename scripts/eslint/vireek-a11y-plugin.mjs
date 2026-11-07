// scripts/eslint/vireek-a11y-plugin.mjs
//
// Two flat-config ESLint rules for the icon system + touch targets (docs/design/ICON_SCALE.md).
//
//  vireek-a11y/icon-only-name   an icon-only <button>/<a>/<Button iconOnly>/<IconButton> must have an accessible name
//                               (aria-label | aria-labelledby | title | a visually hidden sr-only child | IconButton `label`).
//  vireek-a11y/no-raw-icon-size lucide icons must not carry raw size classes (h-N w-N / size-N, N <= 6), a numeric size={N} <= 24
//                               or a strokeWidth. Use the `icon-micro|sm|md|lg` classes or <Icon size="..."/>.
//                               Display icons (> 24px: h-7+ / size={26}+) are exempt.
//
// Spread props ({...props}) are treated as "might provide the name" and never reported.

const ICON_CLASS_TOKEN = /^(?:h|w|size)-(\d+(?:\.\d+)?)$/;
const NAME_ATTRS = new Set(['aria-label', 'aria-labelledby', 'title']);

const elementName = (opening) => {
  const n = opening.name;
  if (n.type === 'JSXIdentifier') return n.name;
  if (n.type === 'JSXMemberExpression') return `${n.object.name ?? ''}.${n.property.name}`;
  return '';
};
const attrs = (opening) => opening.attributes.filter((a) => a.type === 'JSXAttribute');
const attr = (opening, name) => attrs(opening).find((a) => a.name.type === 'JSXIdentifier' && a.name.name === name);
const hasSpread = (opening) => opening.attributes.some((a) => a.type === 'JSXSpreadAttribute');

/** Every string chunk under a node (Literal strings + template quasis). */
function strings(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (node.type === 'Literal' && typeof node.value === 'string') out.push(node.value);
  else if (node.type === 'TemplateElement') out.push(node.value.cooked ?? '');
  for (const k of Object.keys(node)) {
    if (k === 'parent' || k === 'loc' || k === 'range') continue;
    const v = node[k];
    if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && strings(c, out));
    else if (v && typeof v.type === 'string') strings(v, out);
  }
  return out;
}

function lucideTracker() {
  const names = new Set();
  return { names, ImportDeclaration(node) { if (node.source.value === 'lucide-react') node.specifiers.forEach((s) => s.local && names.add(s.local.name)); } };
}

const hasNameAttr = (opening) =>
  attrs(opening).some((a) => {
    if (a.name.type !== 'JSXIdentifier' || !NAME_ATTRS.has(a.name.name)) return false;
    const v = a.value;
    if (!v) return false;
    if (v.type === 'Literal') return String(v.value).trim() !== '';
    return true; // expression: assume it resolves to a string
  });

export const iconOnlyName = {
  meta: { type: 'problem', docs: { description: 'Icon-only buttons and links need an accessible name.' }, schema: [], messages: { missing: 'Icon-only <{{tag}}> has no accessible name. Add aria-label={t(...)} (or use <IconButton label={...} />).' } },
  create(context) {
    const lucide = lucideTracker();
    return {
      ImportDeclaration: lucide.ImportDeclaration,
      JSXElement(node) {
        const opening = node.openingElement;
        const tag = elementName(opening);
        if (!['button', 'a', 'Button', 'IconButton', 'summary'].includes(tag)) return;
        if (hasSpread(opening)) return;
        if (tag === 'IconButton') { if (!attr(opening, 'label')) context.report({ node: opening, messageId: 'missing', data: { tag } }); return; }
        if (hasNameAttr(opening)) return;
        let icon = false;
        for (const c of node.children) {
          if (c.type === 'JSXText') { if (c.value.trim()) return; continue; }
          if (c.type === 'JSXExpressionContainer') { if (c.expression.type !== 'JSXEmptyExpression') return; continue; }
          if (c.type === 'JSXElement' || c.type === 'JSXFragment') {
            const o = c.openingElement;
            const n = o ? elementName(o) : '';
            if (o && (lucide.names.has(n) || n === 'Icon')) { icon = true; continue; }
            return; // any other child (text span, sr-only span, ...) -> not provably icon-only
          }
        }
        if (icon || (tag === 'Button' && attr(opening, 'iconOnly'))) context.report({ node: opening, messageId: 'missing', data: { tag } });
      },
    };
  },
};

export const noRawIconSize = {
  meta: {
    type: 'problem',
    docs: { description: 'Lucide icons use the icon scale tokens, not raw sizes.' },
    schema: [],
    messages: {
      size: 'Raw icon size. Use className="icon-sm" (micro 12 / sm 16 / md 20 / lg 24) or <Icon size="sm" />.',
      stroke: 'Do not set strokeWidth on icons: stroke is constant via the icon-* classes.',
      cls: 'Raw icon size class "{{token}}". Use icon-micro | icon-sm | icon-md | icon-lg (the 3.5 half-step is gone).',
    },
  },
  create(context) {
    const lucide = lucideTracker();
    return {
      ImportDeclaration: lucide.ImportDeclaration,
      JSXOpeningElement(node) {
        if (!lucide.names.has(elementName(node))) return;
        const size = attr(node, 'size');
        if (size) {
          const e = size.value?.type === 'JSXExpressionContainer' ? size.value.expression : size.value;
          const n = e && e.type === 'Literal' ? Number(e.value) : null;
          if (n === null || !(n > 24)) context.report({ node: size, messageId: 'size' }); // dynamic or <= 24 -> report; display (>24) exempt
        }
        const stroke = attr(node, 'strokeWidth');
        if (stroke) context.report({ node: stroke, messageId: 'stroke' });
        const cls = attr(node, 'className');
        if (cls?.value) {
          for (const chunk of strings(cls.value)) {
            for (const t of chunk.split(/\s+/)) {
              const m = ICON_CLASS_TOKEN.exec(t);
              if (m && Number(m[1]) <= 6) context.report({ node: cls, messageId: 'cls', data: { token: t } });
            }
          }
        }
      },
    };
  },
};

export default { meta: { name: 'vireek-a11y' }, rules: { 'icon-only-name': iconOnlyName, 'no-raw-icon-size': noRawIconSize } };

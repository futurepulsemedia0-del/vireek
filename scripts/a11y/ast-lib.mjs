// scripts/a11y/ast-lib.mjs — shared TypeScript-AST helpers for the icon/target audit + codemods.
import ts from 'typescript';

export const parse = (text, name = 'x.tsx') => ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

export function lucideNames(sf) {
  const names = new Set();
  sf.forEachChild((n) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && n.moduleSpecifier.text === 'lucide-react' && n.importClause?.namedBindings && ts.isNamedImports(n.importClause.namedBindings)) {
      n.importClause.namedBindings.elements.forEach((e) => names.add(e.name.text));
    }
  });
  return names;
}

export const openingOf = (n) => (ts.isJsxElement(n) ? n.openingElement : n);
export const tagOf = (n) => openingOf(n).tagName.getText();

export function attrMap(opening) {
  const m = new Map();
  for (const a of opening.attributes.properties) if (ts.isJsxAttribute(a)) m.set(a.name.getText(), a);
  return m;
}
export const hasSpread = (opening) => opening.attributes.properties.some((a) => ts.isJsxSpreadAttribute(a));

/** Every string-ish literal under a node (string, no-substitution template, template head/middle/tail). */
export function literalsIn(node) {
  const out = [];
  const visit = (n) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push({ node: n, kind: 'plain', start: n.getStart() + 1, end: n.getEnd() - 1 });
    else if (ts.isTemplateHead(n)) out.push({ node: n, kind: 'head', start: n.getStart() + 1, end: n.getEnd() - 2 });
    else if (ts.isTemplateMiddle(n)) out.push({ node: n, kind: 'middle', start: n.getStart() + 1, end: n.getEnd() - 2 });
    else if (ts.isTemplateTail(n)) out.push({ node: n, kind: 'tail', start: n.getStart() + 1, end: n.getEnd() - 1 });
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}
export const classText = (attr) => (attr?.initializer ? literalsIn(attr.initializer).map((l) => l.node.text ?? '').join(' ') : '');

export function isIconOnly(n, lucide) {
  if (!ts.isJsxElement(n)) return false;
  let icon = false;
  for (const c of n.children) {
    if (ts.isJsxText(c)) { if (c.text.trim()) return false; continue; }
    if (ts.isJsxExpression(c)) { if (c.expression) return false; continue; }
    if (ts.isJsxElement(c) || ts.isJsxSelfClosingElement(c)) { if (lucide.has(tagOf(c)) || tagOf(c) === 'Icon') { icon = true; continue; } return false; }
  }
  return icon;
}

/** Parse "h-4" / "w-3.5" / "size-5" tokens (unprefixed only). */
export function splitTokens(segment) {
  return segment.split(/(\s+)/); // keeps whitespace parts at odd indexes
}
export const SIZE_TOKEN = /^(h|w|size)-(\d+(?:\.\d+)?)$/;

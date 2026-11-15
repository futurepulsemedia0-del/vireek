/**
 * Turns a help article body (plain text) into render-ready blocks, so authors can write real
 * structure without HTML and without any `dangerouslySetInnerHTML`:
 *
 *   - blank line            → new paragraph
 *   - lines starting "- "   → bullet list   (also "* " or "• ")
 *   - lines starting "1. "  → numbered list (also "1) ")
 *
 * A chunk becomes a list only when EVERY line in it is a list item; otherwise it stays a paragraph,
 * so existing prose is never reinterpreted. Single line breaks inside a paragraph collapse to a space.
 */
export type HelpBodyBlock =
  | { type: 'p'; text: string }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: string[] };

const BULLET = /^\s*[-*•]\s+(\S.*)$/;
const ORDERED = /^\s*\d{1,2}[.)]\s+(\S.*)$/;

export function parseHelpBody(body: string): HelpBodyBlock[] {
  const blocks: HelpBodyBlock[] = [];
  for (const chunk of body.replace(/\r\n?/g, '\n').split(/\n{2,}/)) {
    const lines = chunk.split('\n').filter((line) => line.trim() !== '');
    if (lines.length === 0) continue;

    if (lines.every((line) => BULLET.test(line))) {
      blocks.push({ type: 'ul', items: lines.map((line) => (BULLET.exec(line) as RegExpExecArray)[1].trim()) });
    } else if (lines.every((line) => ORDERED.test(line))) {
      blocks.push({ type: 'ol', items: lines.map((line) => (ORDERED.exec(line) as RegExpExecArray)[1].trim()) });
    } else {
      blocks.push({ type: 'p', text: lines.map((line) => line.trim()).join(' ') });
    }
  }
  return blocks;
}

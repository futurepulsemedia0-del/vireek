import { describe, expect, it } from 'vitest';
import { parseHelpBody } from '@/lib/helpBody';
import { HELP_ARTICLES } from '@/lib/helpArticles';

describe('parseHelpBody', () => {
  it('splits paragraphs on blank lines and collapses single line breaks', () => {
    expect(parseHelpBody('One\nstill one.\n\nTwo.')).toEqual([
      { type: 'p', text: 'One still one.' },
      { type: 'p', text: 'Two.' },
    ]);
  });

  it('parses bullet and numbered lists', () => {
    expect(parseHelpBody('- a\n- b\n\n1. first\n2) second')).toEqual([
      { type: 'ul', items: ['a', 'b'] },
      { type: 'ol', items: ['first', 'second'] },
    ]);
  });

  it('keeps mixed chunks as plain paragraphs instead of guessing', () => {
    expect(parseHelpBody('Intro line\n- not a list')).toEqual([{ type: 'p', text: 'Intro line - not a list' }]);
  });

  it('normalises CRLF and ignores empty input', () => {
    expect(parseHelpBody('A\r\n\r\nB')).toHaveLength(2);
    expect(parseHelpBody('   \n\n  ')).toEqual([]);
  });

  it('never reinterprets any existing article as a list', () => {
    for (const article of HELP_ARTICLES) {
      expect(parseHelpBody(article.body).every((block) => block.type === 'p')).toBe(true);
    }
  });
});

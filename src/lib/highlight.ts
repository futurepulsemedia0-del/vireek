/**
 * Tiny dependency-free syntax highlighter for the docs code samples (shell, JavaScript, Python, Go, JSON).
 * Lossless: joining every token's text gives back the input exactly. Colors live in HIGHLIGHT_THEME and are
 * contrast-checked (WCAG AA, >= 4.5:1) against the code-block background in highlight.test.ts.
 */
export type TokenType = 'comment' | 'string' | 'number' | 'keyword' | 'property' | 'text';
export interface Token {
  type: TokenType;
  text: string;
}
export type HighlightLang = 'shell' | 'javascript' | 'python' | 'go' | 'json';

const KEYWORDS: Record<HighlightLang, string> = {
  shell: 'if|then|else|fi|for|do|done|in|while|export|curl|echo|cd',
  javascript:
    'const|let|var|await|async|function|return|if|else|throw|new|import|export|from|for|of|true|false|null|undefined',
  python:
    'import|from|def|return|if|else|elif|for|in|with|as|True|False|None|print|raise|try|except|class|while',
  go: 'package|import|func|return|if|else|for|range|var|const|type|struct|defer|true|false|nil|go|switch|case',
  json: 'true|false|null',
};
const COMMENT: Record<HighlightLang, string> = {
  shell: '#[^\\n]*',
  python: '#[^\\n]*',
  javascript: '//[^\\n]*|/\\*[\\s\\S]*?\\*/',
  go: '//[^\\n]*|/\\*[\\s\\S]*?\\*/',
  json: '(?!)',
};
const STRING = '"(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\'|`(?:\\\\.|[^`\\\\])*`';

const cache = new Map<HighlightLang, RegExp>();
function rule(lang: HighlightLang): RegExp {
  let re = cache.get(lang);
  if (!re) {
    // Alternation order matters: comment, string, then number/keyword/property. Every branch is linear (no nested quantifiers).
    re = new RegExp(
      `(?<comment>${COMMENT[lang]})|(?<string>${STRING})|(?<number>\\b\\d+(?:\\.\\d+)?\\b)|(?<keyword>\\b(?:${KEYWORDS[lang]})\\b)|(?<property>(?<=\\.)[A-Za-z_$][\\w$]*(?=\\()|--?[A-Za-z][\\w-]*)`,
      'g',
    );
    cache.set(lang, re);
  }
  return re;
}

export function tokenize(code: string, lang: HighlightLang): Token[] {
  const re = new RegExp(rule(lang));
  const out: Token[] = [];
  let last = 0;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    if (m[0] === '') {
      re.lastIndex++;
      continue;
    }
    if (m.index > last) out.push({ type: 'text', text: code.slice(last, m.index) });
    const type =
      (Object.keys(m.groups ?? {}) as TokenType[]).find((k) => m.groups?.[k] !== undefined) ??
      'text';
    out.push({ type, text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < code.length) out.push({ type: 'text', text: code.slice(last) });
  return out;
}

export function langOfTab(id: string): HighlightLang {
  return id === 'curl'
    ? 'shell'
    : id === 'javascript' || id === 'python' || id === 'go' || id === 'json'
      ? id
      : 'shell';
}

/** RGB triplets (same format as src/index.css). `bg` equals --bg-primary, the code block background. */
export const HIGHLIGHT_THEME = {
  light: {
    bg: [253, 252, 250],
    text: [23, 23, 26],
    comment: [88, 94, 106],
    string: [14, 100, 56],
    number: [150, 62, 0],
    keyword: [112, 36, 150],
    property: [24, 52, 180],
  },
  dark: {
    bg: [9, 10, 13],
    text: [242, 241, 238],
    comment: [150, 156, 170],
    string: [130, 220, 160],
    number: [255, 170, 100],
    keyword: [200, 150, 255],
    property: [140, 170, 255],
  },
} as const;

/** Relative luminance / contrast per WCAG 2.x. */
export function contrastRatio(a: readonly number[], b: readonly number[]): number {
  const lum = (c: readonly number[]) => {
    const [r, g, bl] = c.map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

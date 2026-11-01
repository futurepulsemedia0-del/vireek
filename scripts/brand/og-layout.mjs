// Pure layout for the 1200x630 brand cards (satori element objects, no JSX) + text-fit logic.
const el = (type, style, children) => ({ type, props: { style: { display: 'flex', ...style }, children } });

/** Satori only has our Latin fonts: drop glyphs we cannot draw instead of rendering tofu boxes. */
export const sanitize = (s) =>
  String(s ?? '')
    .replace(/[^\u0020-\u007E\u00A0-\u017F\u2010-\u2027\u2030-\u203A\u20AC\u2122]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

export function wrapWords(text, perLine) {
  const lines = [];
  let cur = '';
  for (let w of text.split(/\s+/).filter(Boolean)) {
    while (w.length > perLine) {
      if (cur) {
        lines.push(cur);
        cur = '';
      }
      lines.push(w.slice(0, perLine));
      w = w.slice(perLine);
    }
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= perLine) cur += ` ${w}`;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Largest title size whose estimated wrap fits in maxLines; ellipsis only as a last resort. Sora Bold ~0.6em/char. */
export function fitTitle(title, { maxWidth = 1000, sizes = [76, 68, 60, 52, 46, 40], maxLines = 3, factor = 0.6 } = {}) {
  const text = sanitize(title);
  for (const size of sizes) {
    const per = Math.max(4, Math.floor(maxWidth / (size * factor)));
    const lines = wrapWords(text, per);
    if (lines.length <= maxLines) return { text, size, lines: lines.length, truncated: false };
  }
  const size = sizes[sizes.length - 1];
  const per = Math.max(4, Math.floor(maxWidth / (size * factor)));
  const lines = wrapWords(text, per).slice(0, maxLines);
  const last = lines[maxLines - 1];
  lines[maxLines - 1] = (last.length >= per ? last.slice(0, per - 1) : last).trimEnd() + '\u2026';
  return { text: lines.join(' '), size, lines: maxLines, truncated: true };
}

export function fitTagline(text, max = 120) {
  const clean = sanitize(text);
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 40)).replace(/[\s,;:.\u2013\u2014-]+$/, '')}\u2026`;
}

/** @param {{brand:any,title:string,tagline?:string,kindLabel?:string|null,host?:string,symbolUri:string}} c */
export function buildCardTree({ brand, title, tagline, kindLabel, host, symbolUri }) {
  const B = brand.BRAND;
  const c = B.colors.dark;
  const t = fitTitle(title);
  return el(
    'div',
    {
      width: 1200, height: 630, flexDirection: 'column', justifyContent: 'space-between', padding: 64,
      backgroundColor: c.bg, color: c.text, fontFamily: 'Inter',
      backgroundImage: 'radial-gradient(circle at 92% -10%, rgba(52,72,232,0.50) 0%, rgba(9,10,13,0) 55%)',
    },
    [
      el('div', { alignItems: 'center', justifyContent: 'space-between' }, [
        el('div', { alignItems: 'center' }, [
          { type: 'img', props: { src: symbolUri, width: 68, height: 49 } },
          el('div', { fontFamily: 'Sora', fontWeight: 700, fontSize: 36, marginLeft: 18 }, B.name),
        ]),
        kindLabel
          ? el('div', {
              fontSize: 22, fontWeight: 600, letterSpacing: 3, textTransform: 'uppercase', color: B.colors.accent300,
              border: '2px solid rgba(143,160,251,0.45)', borderRadius: 999, padding: '10px 22px',
            }, kindLabel)
          : null,
      ].filter(Boolean)),
      el('div', { flexDirection: 'column' }, [
        el('div', { fontFamily: 'Sora', fontWeight: 700, fontSize: t.size, lineHeight: 1.08, letterSpacing: -t.size * 0.02, maxWidth: 1000 }, t.text),
        tagline ? el('div', { marginTop: 28, fontSize: 30, lineHeight: 1.35, color: c.muted, maxWidth: 960 }, fitTagline(tagline)) : null,
      ].filter(Boolean)),
      el('div', { justifyContent: 'space-between', alignItems: 'center', fontSize: 24, fontWeight: 600, color: c.muted }, [
        el('div', {}, host ?? B.domain),
        el('div', { color: c.text }, B.tagline),
      ]),
    ],
  );
}

/** Social/app-store art: icon = symbol only, banner = symbol + wordmark + tagline (centered), backdrop = video-call background. */
export function buildKitTree({ brand, layout, w, h, symbolUri }) {
  const B = brand.BRAND;
  const c = B.colors.dark;
  const base = { width: w, height: h, backgroundColor: c.bg, fontFamily: 'Inter', color: c.text };
  const sym = (width) => ({ type: 'img', props: { src: symbolUri, width, height: Math.round((width * 454) / 625) } });
  if (layout === 'icon') {
    return el('div', { ...base, alignItems: 'center', justifyContent: 'center' }, [sym(Math.round(w * 0.5))]);
  }
  if (layout === 'backdrop') {
    return el('div', { ...base, alignItems: 'flex-end', justifyContent: 'flex-start', padding: Math.round(h * 0.06),
      backgroundImage: 'radial-gradient(circle at 100% 0%, rgba(52,72,232,0.35) 0%, rgba(9,10,13,0) 50%)' }, [
      el('div', { alignItems: 'center' }, [
        sym(Math.round(h * 0.07)),
        el('div', { fontFamily: 'Sora', fontWeight: 700, fontSize: Math.round(h * 0.034), marginLeft: Math.round(h * 0.012) }, B.name),
      ]),
    ]);
  }
  const u = h * 0.1; // banner unit
  return el('div', { ...base, alignItems: 'center', justifyContent: 'center', flexDirection: 'column',
    backgroundImage: 'radial-gradient(circle at 90% -20%, rgba(52,72,232,0.45) 0%, rgba(9,10,13,0) 55%)' }, [
    el('div', { alignItems: 'center' }, [
      sym(Math.round(u * 1.9)),
      el('div', { fontFamily: 'Sora', fontWeight: 700, fontSize: Math.round(u * 1.5), marginLeft: Math.round(u * 0.5) }, B.name),
    ]),
    el('div', { marginTop: Math.round(u * 0.5), fontSize: Math.round(u * 0.62), color: c.muted }, `${B.tagline} ${B.descriptor}.`),
  ]);
}

export async function createRenderer({ fonts }) {
  const satori = (await import('satori')).default;
  const { Resvg } = await import('@resvg/resvg-js');
  return async (tree, width, height) => {
    const svg = await satori(tree, { width, height, fonts });
    return new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render().asPng();
  };
}

// Shared helpers for the brand build scripts (OG cards, icons, social kit, validators).
// Heavy deps (satori, @resvg/resvg-js, @fontsource/*) are imported lazily so the pure helpers stay testable.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { ROOT, loadTsModule } from '../seo/routes.mjs';

export { ROOT };

/** Bounding box of the V symbol inside public/assets/logos/logo-dark.png (1024x1024), measured from the file. */
export const SYM = { x: 194, y: 319, w: 625, h: 454 };
const LOGO_PATH = path.join(ROOT, 'public/assets/logos/logo-dark.png');
let logoUri;
const logoDataUri = () => (logoUri ??= `data:image/png;base64,${readFileSync(LOGO_PATH).toString('base64')}`);

export const fail = (msg) => {
  console.error(`[brand] ${msg}`);
  process.exit(1);
};

/** brandConfig.ts bundled with esbuild: the exact strings the app renders. */
export const loadBrand = () => loadTsModule('src/lib/brand/brandConfig.ts');

const ALPHA_FILTER = (id, mono) =>
  `<filter id="${id}" x="0" y="0" width="1" height="1" color-interpolation-filters="sRGB">` +
  `<feColorMatrix type="matrix" values="${mono ? '0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 4 4 4 0 0' : '1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 1 1 1 0 0'}"/></filter>`;

/**
 * The logo file is the symbol on opaque black. The filter turns "brightness" into alpha, so the symbol can sit on any
 * DARK background (brand dark #090A0D) without a black box. mono=true yields a white silhouette for monochrome icons.
 * Put inside an <svg xmlns:xlink=...> root.
 */
export function symbolFragment({ x, y, width, mono = false }) {
  const height = (width * SYM.h) / SYM.w;
  const id = mono ? 'vk-mono' : 'vk-key';
  return (
    `<defs>${ALPHA_FILTER(id, mono)}</defs>` +
    `<svg x="${x}" y="${y}" width="${width}" height="${height}" viewBox="${SYM.x} ${SYM.y} ${SYM.w} ${SYM.h}">` +
    `<image xlink:href="${logoDataUri()}" width="1024" height="1024" filter="url(#${id})"/></svg>`
  );
}

export async function svgToPng(svg, width) {
  const { Resvg } = await import('@resvg/resvg-js');
  const img = new Resvg(svg, { fitTo: { mode: 'width', value: width }, font: { loadSystemFonts: false } }).render();
  return { png: img.asPng(), pixels: img.pixels };
}

/** Transparent PNG of the symbol for satori <img>. Throws if the alpha filter produced nothing (or a solid box). */
export async function renderSymbolDataUri(widthPx = 256) {
  const h = Math.round((widthPx * SYM.h) / SYM.w);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${widthPx}" height="${h}" viewBox="0 0 ${widthPx} ${h}">${symbolFragment({ x: 0, y: 0, width: widthPx })}</svg>`;
  const { png, pixels } = await svgToPng(svg, widthPx);
  let opaque = 0;
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 128) opaque++;
  const ratio = opaque / (pixels.length / 4);
  if (ratio < 0.05 || ratio > 0.7) throw new Error(`symbol alpha coverage ${ratio.toFixed(2)} outside 0.05-0.70 (filter unsupported?)`);
  return `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
}

export function loadFonts() {
  const f = (pkg, file) => {
    try {
      return readFileSync(path.join(ROOT, 'node_modules', '@fontsource', pkg, 'files', file));
    } catch {
      fail(`Missing font ${pkg}/${file}. Run: npm i -D @fontsource/sora @fontsource/inter`);
    }
  };
  return [
    { name: 'Sora', data: f('sora', 'sora-latin-700-normal.woff'), weight: 700, style: 'normal' },
    { name: 'Inter', data: f('inter', 'inter-latin-400-normal.woff'), weight: 400, style: 'normal' },
    { name: 'Inter', data: f('inter', 'inter-latin-600-normal.woff'), weight: 600, style: 'normal' },
  ];
}

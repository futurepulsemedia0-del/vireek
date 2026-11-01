#!/usr/bin/env node
// Generates every static brand asset from the real symbol (public/assets/logos/logo-dark.png):
//   PWA icons (any / maskable / monochrome), apple-touch-icon, Windows tile, shortcut icons, default OG card,
//   and the off-site kit in public/brand-kit/ (profile images, banners, bios, signature, press boilerplate, checklist).
// Run: npm run brand:assets   (commit the output; it does not run in CI builds)
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, SYM, fail, loadBrand, loadFonts, renderSymbolDataUri, svgToPng, symbolFragment } from './lib.mjs';
import { buildCardTree, buildKitTree, createRenderer } from './og-layout.mjs';

const pub = (...p) => path.join(ROOT, 'public', ...p);
const kit = (f) => pub('brand-kit', f);
async function save(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, data);
  console.log(`[brand] ${path.relative(ROOT, file)}`);
}

const brand = await loadBrand();
const { BRAND, BRAND_KIT_IMAGES, PERSONA_LINE, bioShort, pressBoilerplate, copyrightLine } = brand;
const DARK = BRAND.colors.dark.bg;
const XLINK = 'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"';

/** Safe-zone guard: Android maskable icons keep the visible content inside a circle of 40% of the icon. */
const halfDiagonal = (ratio) => 0.5 * ratio * Math.hypot(1, SYM.h / SYM.w);
function iconSvg({ size, bg, ratio, mono = false, radius = 0 }) {
  const sw = size * ratio;
  const sh = (sw * SYM.h) / SYM.w;
  return `<svg ${XLINK} width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${
    bg ? `<rect width="${size}" height="${size}" rx="${size * radius}" fill="${bg}"/>` : ''
  }${symbolFragment({ x: (size - sw) / 2, y: (size - sh) / 2, width: sw, mono })}</svg>`;
}
async function icon(file, spec) {
  if (spec.maskable && halfDiagonal(spec.ratio) > 0.36) fail(`${file}: symbol leaves the maskable safe zone`);
  await save(pub(file), (await svgToPng(iconSvg(spec), spec.size)).png);
}

// ---- PWA / platform icons -------------------------------------------------------------------
await icon('icons/icon-192.png', { size: 192, bg: DARK, ratio: 0.56, radius: 0.2237 });
await icon('icons/icon-512.png', { size: 512, bg: DARK, ratio: 0.56, radius: 0.2237 });
await icon('icons/maskable-192.png', { size: 192, bg: DARK, ratio: 0.5, maskable: true });
await icon('icons/maskable-512.png', { size: 512, bg: DARK, ratio: 0.5, maskable: true });
await icon('icons/monochrome-512.png', { size: 512, ratio: 0.5, mono: true });
await icon('icons/monochrome-96.png', { size: 96, ratio: 0.62, mono: true }); // notification badge (sw.js)
await icon('apple-touch-icon.png', { size: 180, bg: DARK, ratio: 0.58 }); // iOS applies its own corner mask
await icon('mstile-150x150.png', { size: 150, bg: DARK, ratio: 0.5 });
await save(
  pub('browserconfig.xml'),
  `<?xml version="1.0" encoding="utf-8"?>\n<browserconfig><msapplication><tile><square150x150logo src="/mstile-150x150.png"/><TileColor>${DARK}</TileColor></tile></msapplication></browserconfig>\n`,
);

// ---- shortcut icons (distinct glyphs from lucide-react, same family the app UI uses) -----------
{
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const Lucide = await import('lucide-react');
  for (const [file, name] of [['jobs', 'Briefcase'], ['calls', 'Phone'], ['inbox', 'Inbox']]) {
    if (!Lucide[name]) fail(`lucide-react has no ${name}`);
    const glyph = renderToStaticMarkup(React.createElement(Lucide[name], { size: 44, color: BRAND.colors.accent300, strokeWidth: 2 }));
    const svg = `<svg ${XLINK} width="96" height="96" viewBox="0 0 96 96"><rect width="96" height="96" rx="21" fill="${DARK}"/><g transform="translate(26 26)">${glyph}</g></svg>`;
    await save(pub(`icons/shortcut-${file}-96.png`), (await svgToPng(svg, 96)).png);
  }
}

// ---- cards + kit images (satori) ----------------------------------------------------------------
const fonts = loadFonts();
const render = await createRenderer({ fonts });
const symbolUri = await renderSymbolDataUri(512);

await save(
  pub('og-image.png'),
  await render(
    buildCardTree({
      brand,
      title: BRAND.tagline,
      tagline: `${BRAND.descriptor.charAt(0).toUpperCase()}${BRAND.descriptor.slice(1)}.`,
      kindLabel: null,
      host: BRAND.domain,
      symbolUri,
    }),
    1200,
    630,
  ),
);
for (const f of BRAND_KIT_IMAGES) {
  await save(kit(f.file), await render(buildKitTree({ brand, layout: f.layout, w: f.w, h: f.h, symbolUri }), f.w, f.h));
  if (f.opaque) console.warn(`[brand] NOTE ${f.file}: PNG has an alpha channel; App Store Connect rejects that. Strip it: magick ${f.file} -background "${DARK}" -alpha remove -alpha off ${f.file}`);
}

// ---- text kit -----------------------------------------------------------------------------------
const long = `${BRAND.description} ${PERSONA_LINE}, answers every call, qualifies the lead, flags emergencies and books the job. ${BRAND.siteUrl}`;
await save(kit('bios.txt'), `SHORT (<=160)\n${bioShort()} ${BRAND.siteUrl}\n\nMEDIUM\n${BRAND.description}\n\nLONG\n${long}\n`);
await save(
  kit('link-in-bio.txt'),
  `Headline: ${BRAND.name} \u2014 ${BRAND.tagline}\nSub: ${BRAND.descriptor}.\nPrimary link: ${BRAND.siteUrl}/demo?utm_source=bio  (Hear ${BRAND.persona} answer a call)\nSecondary: ${BRAND.siteUrl}/pricing?utm_source=bio  (Pricing)\nTertiary: ${BRAND.siteUrl}/blog?utm_source=bio  (Blog)\n`,
);
await save(kit('press-boilerplate.txt'), `${pressBoilerplate()}\n`);
const sig = (name, title) => `<table cellpadding="0" cellspacing="0" role="presentation" style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.4;color:${BRAND.colors.light.text}">
  <tr>
    <td style="padding-right:14px;vertical-align:top"><img src="${BRAND.siteUrl}/brand-kit/email-signature-logo-240x240.png" width="60" height="60" alt="${BRAND.name}" style="display:block;border-radius:12px"></td>
    <td style="vertical-align:top">
      <div style="font-weight:700;font-size:15px">${name}</div>
      <div style="color:${BRAND.colors.light.muted}">${title} \u00B7 ${BRAND.name}</div>
      <div style="margin-top:6px"><a href="${BRAND.siteUrl}" style="color:${BRAND.colors.light.accent};text-decoration:none">${BRAND.domain}</a></div>
      <div style="margin-top:8px;font-size:12px;color:${BRAND.colors.light.muted}">${BRAND.name} \u2014 ${BRAND.tagline}</div>
    </td>
  </tr>
</table>
`;
await save(kit('email-signature.html'), `<!-- Replace {{NAME}} and {{TITLE}}. Table layout + inline styles + hosted image = survives Gmail/Outlook. -->\n${sig('{{NAME}}', '{{TITLE}}')}`);
await save(
  kit('CHECKLIST.md'),
  `# ${BRAND.name} off-site profile checklist\n\nStrings come from src/lib/brand/brandConfig.ts. Sizes change; confirm on the platform at upload time.\n\n| Platform | Profile image | Cover/banner | Copy | Link |\n|---|---|---|---|---|\n| LinkedIn (company) | profile-400.png | linkedin-company-cover-1128x191.png | bios.txt (medium) | ${BRAND.siteUrl} |\n| LinkedIn (founder) | personal photo | linkedin-banner-1584x396.png | bios.txt (short) | ${BRAND.siteUrl} |\n| X | profile-400.png | x-header-1500x500.png | bios.txt (short) | ${BRAND.siteUrl} |\n| Facebook | profile-400.png | facebook-cover-1640x624.png | bios.txt (medium) | ${BRAND.siteUrl} |\n| YouTube | profile-1024.png (800x800 min) | youtube-banner-2560x1440.png (safe area 1546x423 centered) | bios.txt (long) | ${BRAND.siteUrl} |\n| Google Business Profile | profile-1024.png | google-business-cover-1080x608.png | bios.txt (medium) | ${BRAND.siteUrl} |\n| G2 / Capterra | profile-400.png | n/a | bios.txt (long) | ${BRAND.siteUrl} |\n| Apple App Store | app-store-icon-1024.png (no alpha) | n/a | bios.txt | ${BRAND.siteUrl} |\n| Google Play | google-play-icon-512.png | google-play-feature-1024x500.png | bios.txt | ${BRAND.siteUrl} |\n| Slack / Discord app | slack-discord-icon-512.png | n/a | bios.txt (short) | ${BRAND.siteUrl} |\n| Zoom / Teams | n/a | video-background-1920x1080.png | n/a | n/a |\n\n## Rules\n- Name: "${BRAND.name}" (capital V). Persona: "${PERSONA_LINE}". Tagline: "${BRAND.tagline}"\n- Use ${BRAND.name}\u2122 once, prominently. Never \u00AE until a registration exists.\n- Footer line: ${copyrightLine()}\n- Handles in brandFacts.ts are the source of truth; keep them identical on every platform.\n`,
);
console.log('[brand] done. Review: npm run brand:gallery');

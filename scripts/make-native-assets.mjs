// Builds the icon + splash sources that `capacitor-assets generate` expects, from the brand logo.
// Usage: npm run native:assets
import { mkdirSync } from 'node:fs';
import sharp from 'sharp';

const LOGO = 'public/favicon.svg';
const BG = '#000000';
mkdirSync('assets', { recursive: true });

const logo = (size) =>
  sharp(LOGO, { density: 300 }).resize(size, size, { fit: 'contain', background: BG }).flatten({ background: BG });

async function padded(size, scale) {
  const inner = Math.round(size * scale);
  const buf = await logo(inner).png().toBuffer();
  const edge = Math.floor((size - inner) / 2);
  return sharp(buf).extend({ top: edge, bottom: size - inner - edge, left: edge, right: size - inner - edge, background: BG });
}

await logo(1024).png().toFile('assets/icon-only.png');
await sharp({ create: { width: 1024, height: 1024, channels: 3, background: BG } }).png().toFile('assets/icon-background.png');
// Android adaptive icons crop to a circle: keep the mark inside the 66% safe zone.
await (await padded(1024, 0.85)).png().toFile('assets/icon-foreground.png');
for (const name of ['splash', 'splash-dark']) {
  await (await padded(2732, 0.34)).png().toFile(`assets/${name}.png`);
}
console.log('assets/ ready — now run: npx capacitor-assets generate');

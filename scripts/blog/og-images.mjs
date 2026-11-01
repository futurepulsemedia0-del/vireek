#!/usr/bin/env node
// Generates one 1200x630 Open Graph / Twitter card per post: dist/og/blog/<slug>.png
// Uses the Chromium that `prerender.mjs` already needs (@playwright/test). Runs after prerender.
// Env: OG_OPTIONAL=1 -> warn instead of failing the build when Chromium is unavailable.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { chromium } from '@playwright/test';
import { ROOT } from '../seo/routes.mjs';
import { loadBlog } from './pipeline.mjs';

const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const OPTIONAL = process.env.OG_OPTIONAL === '1';

const card = ({ title, category, minutes }) => `<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
body{width:1200px;height:630px;font-family:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#0f172a;
background:radial-gradient(circle at 85% 0%,#c7d2fe 0,transparent 55%),#f8fafc;padding:72px;display:flex;flex-direction:column;justify-content:space-between}
.tag{display:inline-block;font-size:26px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#203ad8}
h1{font-size:${title.length > 48 ? 62 : 74}px;line-height:1.1;font-weight:800;letter-spacing:-.02em;max-width:1030px}
.foot{display:flex;justify-content:space-between;align-items:center;font-size:30px;color:#475569}
.brand{font-weight:800;color:#0f172a;font-size:38px}
</style><div class="tag">${esc(category)}</div><h1>${esc(title)}</h1>
<div class="foot"><span class="brand">Vireek</span><span>${minutes} min read · vireek.com/blog</span></div>`;

const blog = loadBlog({ root: ROOT });
if (blog.errors.length) {
  console.error('[og] blog content has errors; run npm run blog:validate');
  process.exit(1);
}
const outDir = path.join(ROOT, 'dist', 'og', 'blog');
mkdirSync(outDir, { recursive: true });

let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  for (const p of blog.posts) {
    const category = blog.categories.find((c) => c.slug === p.category)?.name ?? 'Blog';
    await page.setContent(card({ title: p.title, category, minutes: p.readTimeMinutes }));
    await page.screenshot({ path: path.join(outDir, `${p.slug}.png`), type: 'png' });
  }
  console.log(`[og] ${blog.posts.length} image(s) -> dist/og/blog/`);
} catch (e) {
  const msg = `[og] could not generate images: ${String(e.message).split('\n')[0]}`;
  if (OPTIONAL) console.warn(`${msg} (OG_OPTIONAL=1, continuing; posts fall back to a missing image URL)`);
  else {
    console.error(msg);
    process.exitCode = 1;
  }
} finally {
  await browser?.close();
}

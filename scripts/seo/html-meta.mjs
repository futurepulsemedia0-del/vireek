/** Tiny dependency-free <head> reader used by the prerender step and the built-output test. */
const attr = (tag, name) => {
  const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`, 'i').exec(tag);
  return m ? m[1] : null;
};

export function extractHead(html) {
  const headEnd = html.indexOf('</head>');
  const head = headEnd === -1 ? html : html.slice(0, headEnd);
  const body = headEnd === -1 ? '' : html.slice(headEnd);
  const metas = [...head.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0]);
  const links = [...head.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
  const meta = (key, val) => {
    const t = metas.find((x) => attr(x, key) === val);
    return t ? attr(t, 'content') : null;
  };

  const rootStart = body.indexOf('<div id="root"');
  const rootHtml = rootStart === -1 ? '' : body.slice(rootStart);
  const rootText = rootHtml
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    lang: (/<html\b[^>]*\blang="([^"]*)"/i.exec(html) ?? [])[1] ?? null,
    title: ((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(head) ?? [])[1] ?? '').trim(),
    description: meta('name', 'description'),
    robots: meta('name', 'robots'),
    ogTitle: meta('property', 'og:title'),
    ogDescription: meta('property', 'og:description'),
    ogUrl: meta('property', 'og:url'),
    ogImage: meta('property', 'og:image'),
    twitterCard: meta('name', 'twitter:card'),
    canonicals: links.filter((l) => attr(l, 'rel') === 'canonical').map((l) => attr(l, 'href')),
    hreflang: links
      .filter((l) => attr(l, 'rel') === 'alternate' && attr(l, 'hreflang'))
      .map((l) => ({ hreflang: attr(l, 'hreflang'), href: attr(l, 'href') })),
    jsonLd: [
      ...head.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi),
    ].map((m) => m[1]),
    h1Count: (rootHtml.match(/<h1\b/gi) ?? []).length,
    rootTextLength: rootText.length,
    leftoverManaged: /data-seo-managed/.test(html),
    ssgTagCount: (html.match(/data-ssg="1"/g) ?? []).length,
  };
}

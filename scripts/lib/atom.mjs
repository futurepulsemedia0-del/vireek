// Pure Atom 1.0 builder shared by scripts/generate-rss.mjs (and unit-testable on its own).

export function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * @param {{title:string, subtitle:string, siteUrl:string, feedPath:string, linkPath:string,
 *          items:{id:string,title:string,link:string,updated:string,summary:string,categories?:string[]}[]}} f
 * `updated` must be an ISO-8601 timestamp. Items are emitted in the order given.
 */
export function buildAtom(f) {
  const feedUpdated = f.items.reduce((max, i) => (i.updated > max ? i.updated : max), f.items[0]?.updated ?? '1970-01-01T00:00:00Z');
  const entries = f.items
    .map(
      (i) => `  <entry>
    <id>${escapeXml(i.id)}</id>
    <title>${escapeXml(i.title)}</title>
    <link rel="alternate" type="text/html" href="${escapeXml(i.link)}"/>
    <updated>${escapeXml(i.updated)}</updated>
${(i.categories ?? []).map((c) => `    <category term="${escapeXml(c)}"/>`).join('\n')}${i.categories?.length ? '\n' : ''}    <summary type="text">${escapeXml(i.summary)}</summary>
  </entry>`
    )
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>${escapeXml(f.siteUrl + f.linkPath)}</id>
  <title>${escapeXml(f.title)}</title>
  <subtitle>${escapeXml(f.subtitle)}</subtitle>
  <link rel="self" type="application/atom+xml" href="${escapeXml(f.siteUrl + f.feedPath)}"/>
  <link rel="alternate" type="text/html" href="${escapeXml(f.siteUrl + f.linkPath)}"/>
  <updated>${escapeXml(feedUpdated)}</updated>
${entries}
</feed>
`;
}

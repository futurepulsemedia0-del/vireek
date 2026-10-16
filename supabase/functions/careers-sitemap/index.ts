// supabase/functions/careers-sitemap/index.ts
//
// Serves /sitemap-careers.xml (proxied by a rewrite in vercel.json): /careers plus one URL per OPEN
// posting. Reads with the anon key, so RLS guarantees drafts and closed roles never appear.
//
// Deploy (public endpoint, no JWT):
//   supabase functions deploy careers-sitemap --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const SITE = "https://vireek.com";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

Deno.serve(async (req: Request) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
  const { data, error } = await supabase
    .from("job_postings")
    .select("slug, updated_at")
    .eq("status", "open")
    .order("published_at", { ascending: false })
    .limit(1000);

  if (error) {
    return new Response("Sitemap temporarily unavailable", { status: 503, headers: { "Retry-After": "300" } });
  }

  const rows = data ?? [];
  const latest = rows.reduce((max, r) => (r.updated_at > max ? r.updated_at : max), "");
  const entries = [
    `  <url>\n    <loc>${SITE}/careers</loc>${latest ? `\n    <lastmod>${latest.slice(0, 10)}</lastmod>` : ""}\n    <changefreq>weekly</changefreq>\n    <priority>0.6</priority>\n  </url>`,
    ...rows.map(
      (r) =>
        `  <url>\n    <loc>${SITE}/careers/${esc(r.slug)}</loc>\n    <lastmod>${r.updated_at.slice(0, 10)}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.7</priority>\n  </url>`,
    ),
  ];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join("\n")}\n</urlset>\n`;

  return new Response(req.method === "HEAD" ? null : xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=3600",
    },
  });
});

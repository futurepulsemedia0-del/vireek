# Blog content

One Markdown file per article: `content/blog/<slug>.md` (file name = slug). Authors live in `_authors.json`,
topic hubs in `_categories.json`. Run `npm run blog:validate` (CI runs it too).

## Frontmatter
```yaml
---
title: "≤ 60 characters"
slug: kebab-case-slug            # must equal the file name; reserved: category, tag, page, feed, rss, atom, search, newsletter
description: "140–160 characters"
category: missed-calls           # a slug from _categories.json
tags: [speed-to-lead, hvac]
author: vireek-team              # a key from _authors.json
publishedAt: 2026-11-03          # future date = hidden until then (needs a daily rebuild); draft: true hides always
updatedAt: 2026-11-03
featured: false                  # newest featured post is the index hero
popularRank: 1                   # optional, editor-picked "Popular" (1 = first)
pillar: false
legalReview: false               # true shows a "not legal advice" note; set reviewedBy once a qualified person reviewed
cover: { src: /blog/x.webp, alt: "…", width: 1200, height: 630 }   # optional; file must exist in public/
faq:                             # 3–5 recommended; becomes FAQPage JSON-LD
  - { q: "Question?", a: "Answer with [a link](/pricing) if useful." }
relatedSlugs: [other-slug]       # shown first in "Keep reading"
cta: { type: calculator }        # trial | demo | pricing | calculator (+ optional heading, body)
reviewedBy: { name: "…", role: "…", date: 2026-11-04 }
sources: [{ title: "…", url: "https://…" }]
---
```
`readTime` is calculated automatically; do not add it.

## Body syntax
`##` / `###` headings (no `#`), paragraphs, `-` and `1.` lists, GFM tables, `> pull quote`,
`**bold**`, `*italic*`, `` `code` ``, `[links](/internal)`. Raw HTML is not supported (shown as text).

```
:::tip            :::warning            :::stat           (callouts; body = normal Markdown)
:::takeaways      (one bullet list)     :::steps          (one numbered list)
:::cta type=demo heading="…" button="…"
Optional one-line body.
:::
:::calculator
:::
:::figure src=/blog/x.svg alt="Descriptive alt text" width=800 height=450
Caption
:::
```

## Rules enforced in CI
Required fields · title ≤ 60 · description 140–160 · unique slugs · known category/author · valid dates ·
broken internal links · ≥ 3 links to other posts and ≥ 1 product/pricing link in each post · existing cover/figure files ·
heading order (h2 → h3) · figure alt text + dimensions. `--strict` also fails on warnings (placeholder author, no FAQ, no sources, < 1,500 words).

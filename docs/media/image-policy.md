# Image policy

1. Use `<Img>` (`src/components/ui/Img.tsx`) for every image. Raw `<img>` is allowed only where the ESLint rule `vireek-img/policy` passes.
2. **Alt**: informative → concise, localized `t('images.…')`, no "image of…"; decorative → `decorative` (alt="" + aria-hidden); images of text → avoid, or put the full text in alt.
3. **Space**: `width`+`height` (intrinsic) or `aspectRatio`. Images that fill a parent need a parent with `aspect-*` / fixed `h-*`.
4. **Loading**: `lazy` + `async` by default. Exactly one LCP image per route may use `priority`.
5. **Formats**: put sources in `public/`, run `npm run images:build` (AVIF/WebP, 480–1600w). Pass `asset="name"` to `<Img>` / use `<RevealImage name="…">`.
6. **Budget**: `npm run check:assets` (bytes) and `npm run check:images` (counts ratchet). Lower `scripts/media/image-baseline.json` when you fix images; never raise it.
7. **Human review required**: alt wording and the 9-language `images.*` translations.

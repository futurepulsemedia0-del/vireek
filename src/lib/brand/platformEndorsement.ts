// src/lib/brand/platformEndorsement.ts
//
// Client-side reader for the PLATFORM-level endorsement flag (build-time Vite env, never a tenant
// setting). Env is read at call time through literal `import.meta.env.X` accesses so Vite can
// statically replace them in production builds and tests can stub them.
//
//   VITE_PLATFORM_ENDORSEMENT_ENABLED = true | 1   (default: unset = OFF)
//   VITE_PLATFORM_PARENT_NAME         = "Acme Group"
//   VITE_PLATFORM_PARENT_URL          = "https://acme.example"   (optional, https only)

import { BRAND } from './brandConfig';
import {
  buildParentOrganizationJsonLd,
  isEndorsementSurfacePath,
  resolveEndorsement,
  type BrandEndorsement,
} from './endorsement';

export function getEndorsement(): BrandEndorsement {
  return resolveEndorsement({
    enabled: import.meta.env.VITE_PLATFORM_ENDORSEMENT_ENABLED,
    parentName: import.meta.env.VITE_PLATFORM_PARENT_NAME,
    parentUrl: import.meta.env.VITE_PLATFORM_PARENT_URL,
  });
}

/** "Part of {parent}" or null (flag OFF, or parent name unset/invalid). */
export function getEndorsementLine(): string | null {
  return getEndorsement().line;
}

/** Line for a platform-owned page at `pathname`; null for tenant/unknown surfaces. */
export function getEndorsementLineForPath(pathname: string): string | null {
  return isEndorsementSurfacePath(pathname) ? getEndorsementLine() : null;
}

export function getParentOrganizationJsonLd(): Record<string, unknown> | null {
  return buildParentOrganizationJsonLd(getEndorsement(), { name: BRAND.name, url: BRAND.siteUrl });
}

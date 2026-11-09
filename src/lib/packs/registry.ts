/**
 * Pack registry: every pack version the code base ships. Add a trade = add a manifest here.
 * Published versions are immutable (the database refuses to change them), so to change a pack,
 * add a NEW version; never edit an old one.
 */

import { BASELINE_PACKS } from './baseline';
import { SAMPLE_PACK_V1, SAMPLE_PACK_V1_1 } from './sample';
import { flattenPack, validatePack } from './schema';
import type { Artifact, ArtifactId, PackManifest } from './types';
import { artifactId } from './schema';

export const PACK_ENTITLEMENT_PREFIX = 'packs:';
export const packEntitlementKey = (packId: string) => `${PACK_ENTITLEMENT_PREFIX}${packId}`;

export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

export const PACK_VERSIONS: PackManifest[] = [...BASELINE_PACKS, SAMPLE_PACK_V1, SAMPLE_PACK_V1_1];

export function listPackIds(): string[] {
  return [...new Set(PACK_VERSIONS.map((p) => p.id))];
}

export function versionsOf(packId: string): PackManifest[] {
  return PACK_VERSIONS.filter((p) => p.id === packId).sort((a, b) => compareSemver(a.version, b.version));
}

export function getPackVersion(packId: string, version: string): PackManifest | undefined {
  return PACK_VERSIONS.find((p) => p.id === packId && p.version === version);
}

export function latestVersion(packId: string): PackManifest | undefined {
  return versionsOf(packId).at(-1);
}

/** id -> content for one version; the engine's `manifestOf` source. */
export function artifactMap(p: PackManifest): Map<ArtifactId, Artifact> {
  return new Map(flattenPack(p).map((a) => [artifactId(a.kind, a.key), a]));
}

/** Throws with every problem listed. Run in CI (registry.test) so a bad pack can never ship. */
export function assertRegistryValid(): void {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const p of PACK_VERSIONS) {
    const tag = `${p.id}@${p.version}`;
    if (seen.has(tag)) problems.push(`${tag}: published twice`);
    seen.add(tag);
    const r = validatePack(p);
    if (!r.ok) for (const i of r.issues) problems.push(`${tag} ${i.path}: ${i.message}`);
  }
  if (problems.length) throw new Error(`Invalid trade packs:\n${problems.join('\n')}`);
}

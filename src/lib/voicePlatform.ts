// Recreated: verify against original intent
// src/lib/voicePlatform.ts
//
// Voice Platform "vertical packs": which kind of business the assistant is set up for. The wizard saves the id as
// `business_profile.vertical_id`; a pack marked `regulated` additionally needs the owner's compliance acknowledgement.
//
// TODO(vireek): only the default `home_services` pack is known from this repository (it is the id the wizard
// writes by default). The original registry of other packs, in particular which ones are `regulated` and their exact
// compliance wording, is NOT in the repository and is deliberately not invented here: compliance text is a legal
// decision. Add those packs to VERTICAL_PACKS from the original.
// TODO(vireek): backend missing. No table for per-vertical settings / compliance acknowledgements exists in
// supabase/migrations. `fetchVerticalSettings` and `saveVerticalSelection` therefore refuse instead of pretending
// to record an acknowledgement. They are only reached for regulated packs, and none is registered yet.

export interface VerticalPack {
  id: string;
  label: string;
  description: string;
  /** Regulated packs need an explicit owner acknowledgement before launch. */
  regulated: boolean;
  /** Shown next to the acknowledgement checkbox for regulated packs. */
  complianceNotice?: string;
}

export const DEFAULT_VERTICAL_ID = 'home_services';

export const VERTICAL_PACKS: readonly VerticalPack[] = [
  {
    id: DEFAULT_VERTICAL_ID,
    label: 'Home services',
    description: 'Plumbing, HVAC, electrical, roofing and other field-service trades.',
    regulated: false,
  },
];

export interface VerticalSettings {
  verticalId: string;
  complianceAckAt: string | null;
}

export class VoicePlatformBackendMissingError extends Error {
  constructor() {
    super('Per-industry compliance settings are not available in this deployment.');
    this.name = 'VoicePlatformBackendMissingError';
  }
}

export function getPack(id: string | null | undefined): VerticalPack | undefined {
  return id ? VERTICAL_PACKS.find((p) => p.id === id) : undefined;
}

export function listPacks(): readonly VerticalPack[] {
  return VERTICAL_PACKS;
}

/** Any unknown, empty or malformed id falls back to the default pack. Never throws. */
export function normalizeVerticalId(id: string | null | undefined): string {
  const v = typeof id === 'string' ? id.trim().toLowerCase() : '';
  return getPack(v) ? v : DEFAULT_VERTICAL_ID;
}

export async function fetchVerticalSettings(_ownerId: string, _verticalId: string): Promise<VerticalSettings> {
  throw new VoicePlatformBackendMissingError();
}

export async function saveVerticalSelection(_input: { ownerId: string; actorId: string; verticalId: string; acknowledge: boolean }): Promise<void> {
  throw new VoicePlatformBackendMissingError();
}

// supabase/functions/_shared/voice/registry.ts
//
// Picks a VoiceProvider. Pure. Vapi is the default and, today, the ONLY provider that can take traffic.
// A provider whose isReady() is false is never returned (stubs can never receive calls).

import type { VoiceProvider, VoiceProviderId } from "./provider.ts";
import { NullProvider } from "./mockProvider.ts";

export function resolveVoiceProvider(
  providers: Partial<Record<VoiceProviderId, VoiceProvider>>,
  requested: string | null | undefined,
): { provider: VoiceProvider; reason: "requested" | "default_vapi" | "requested_not_ready" | "no_ready_provider" } {
  const wanted = requested && providers[requested as VoiceProviderId];
  if (wanted && wanted.isReady()) return { provider: wanted, reason: "requested" };
  const vapi = providers.vapi;
  if (vapi && vapi.isReady()) return { provider: vapi, reason: wanted ? "requested_not_ready" : "default_vapi" };
  return { provider: new NullProvider(), reason: "no_ready_provider" };
}

// supabase/functions/_shared/compliance/stateDnc/gate.ts
//
// Deno-only glue used by the dial paths: binds scrubBeforeDial() to the existing internal DNC check (dncCheck.ts) and to
// STATE_DNC_GATE_MODE (shadow | enforce, default shadow). Call it right BEFORE the fraud/budget reservation and the
// provider call, so a held call never has anything to release.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { isDncSuppressed } from "../dncCheck.ts";
import { parseGateMode, scrubBeforeDial, type ScrubRequest, type ScrubResult } from "./scrub.ts";

export type { ScrubRequest, ScrubResult } from "./scrub.ts";

export function scrubForDial(admin: SupabaseClient, req: ScrubRequest): Promise<ScrubResult> {
  return scrubBeforeDial(
    {
      admin,
      gateMode: parseGateMode(Deno.env.get("STATE_DNC_GATE_MODE")),
      isInternallySuppressed: (ownerId, phone) => isDncSuppressed(admin, ownerId, phone),
    },
    req,
  );
}

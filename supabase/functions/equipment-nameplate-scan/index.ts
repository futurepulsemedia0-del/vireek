// supabase/functions/equipment-nameplate-scan/index.ts
//
// Technician data-plate scan: photo -> OCR -> equipment record -> equipment passport + warranty status.
// All logic lives in ../_shared/property-vision/nameplate-handler.ts (documented there); this file only
// wires the Deno runtime into it.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { handleNameplateRequest } from "../_shared/property-vision/nameplate-handler.ts";

Deno.serve((req: Request) =>
  handleNameplateRequest(req, { createClient, env: (name) => Deno.env.get(name), fetch })
);

// supabase/functions/portal-home-inventory/index.ts
//
// Customer portal Home Inventory: signed uploads, OCR of labels / receipts / warranty cards, file viewing and
// deletion. Authenticated by the customer's portal token (NOT a Supabase JWT), so it MUST be deployed with
// --no-verify-jwt (listed in supabase/config.toml). All logic lives in
// ../_shared/home-inventory/handler.ts (documented there); this file only wires the Deno runtime into it.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { handleHomeInventoryRequest } from "../_shared/home-inventory/handler.ts";

Deno.serve((req: Request) =>
  handleHomeInventoryRequest(req, { createClient, env: (name) => Deno.env.get(name), fetch })
);

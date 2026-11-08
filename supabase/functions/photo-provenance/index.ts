// supabase/functions/photo-provenance/index.ts
// Thin Deno entry point; all logic is in ../_shared/photo-provenance/handler.ts (unit-tested).
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { handlePhotoProvenance } from "../_shared/photo-provenance/handler.ts";

Deno.serve((req: Request) => handlePhotoProvenance(req, { createClient, env: (name) => Deno.env.get(name) }));

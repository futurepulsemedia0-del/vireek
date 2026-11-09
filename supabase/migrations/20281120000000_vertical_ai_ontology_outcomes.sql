/*
  # Vertical AI: trade ontology + outcome-event contracts (2028-11-20)

  Adds (all additive, idempotent, no existing table/column/policy touched):
    1. vertical_ontology_entries   GLOBAL, versioned trade knowledge (symptom -> causes -> checks -> parts -> labor,
                                   safety rules, permit triggers). Every row carries source, effective date,
                                   jurisdiction, confidence and a reviewed flag. Contains NO tenant data and NO prices
                                   (prices only ever come from the tenant's price_book_items). Read-only for clients.
    2. vertical_outcome_events     per-tenant predicted-vs-confirmed records (diagnosis cause, quoted vs final price,
                                   parts predicted vs used): the write points the Outcome Learning layer consumes.
                                   Written only through the service-role RPCs below; tenant-scoped SELECT.
    3. record_vertical_prediction / record_vertical_confirmation   idempotent writers (service_role only).
    4. vertical_ai_quality(p_days)  tenant-scoped dashboard rollup over the EXISTING call_trace_events (events named
                                   vai_*), plus vertical_outcome_accuracy() over the new table.

  Rollback (data-only impact on the new objects):
    DROP FUNCTION IF EXISTS public.vertical_outcome_accuracy(integer);
    DROP FUNCTION IF EXISTS public.vertical_ai_quality(integer);
    DROP FUNCTION IF EXISTS public.record_vertical_confirmation(uuid, text, text, text, jsonb);
    DROP FUNCTION IF EXISTS public.record_vertical_prediction(uuid, text, text, text, jsonb, text[]);
    DROP TABLE IF EXISTS public.vertical_outcome_events;
    DROP TABLE IF EXISTS public.vertical_ontology_entries;
*/

-- =============================================================
-- 1. GLOBAL ONTOLOGY
-- =============================================================
CREATE TABLE IF NOT EXISTS public.vertical_ontology_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trade text NOT NULL CHECK (trade IN ('hvac', 'plumbing', 'electrical', 'all')),
  kind text NOT NULL CHECK (kind IN ('symptom', 'safety_rule', 'permit_trigger', 'code_note', 'parts_labor')),
  key text NOT NULL CHECK (key ~ '^[a-z0-9_]{2,60}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND pg_column_size(payload) <= 16384),
  source text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 500),
  source_url text,
  effective_on date NOT NULL,
  expires_on date,
  jurisdiction text NOT NULL DEFAULT 'US' CHECK (jurisdiction ~ '^[A-Z]{2}(-[A-Z0-9]{1,3})?$'),
  confidence numeric NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  reviewed boolean NOT NULL DEFAULT false,
  reviewed_by text,
  reviewed_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trade, kind, key, version, jurisdiction),
  CHECK (expires_on IS NULL OR expires_on > effective_on),
  CHECK (NOT reviewed OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_vertical_ontology_lookup
  ON public.vertical_ontology_entries (trade, kind, status, jurisdiction);

ALTER TABLE public.vertical_ontology_entries ENABLE ROW LEVEL SECURITY;

-- Global reference data: safe to expose read-only to every signed-in tenant. No INSERT/UPDATE/DELETE policy:
-- only the service role (migrations / editorial tooling) writes it.
DROP POLICY IF EXISTS "select_active_vertical_ontology" ON public.vertical_ontology_entries;
CREATE POLICY "select_active_vertical_ontology" ON public.vertical_ontology_entries
  FOR SELECT TO authenticated USING (status = 'active');
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.vertical_ontology_entries FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.vertical_ontology_entries FROM anon;

-- Seed (version 1). Keep in sync with supabase/functions/_shared/vertical-ai/ontologySeed.ts (a test enforces parity).
-- reviewed = false everywhere: NOT yet reviewed by a licensed HVAC/plumbing/electrical professional.
INSERT INTO public.vertical_ontology_entries
  (trade, kind, key, version, title, payload, source, effective_on, expires_on, jurisdiction, confidence, reviewed)
VALUES
  ('all', 'safety_rule', 'gas_odor', 1, 'Gas odor / suspected gas leak', '{"flag":"gas_odor","guidance":"Please leave the building now and leave the door open behind you. Don''t use light switches, lighters or phones inside. From outside, call 911 or your gas utility''s emergency line. I''m alerting our on-call technician right now."}'::jsonb, 'Vireek editorial v1 - standard public-safety guidance summary (not yet reviewed by a licensed professional)', '2026-11-01', NULL, 'US', 0.9, false),
  ('all', 'safety_rule', 'carbon_monoxide', 1, 'Carbon monoxide alarm or symptoms', '{"flag":"carbon_monoxide","guidance":"Get everyone outside into fresh air right now and call 911. Don''t go back in until emergency responders say it''s safe. I''m alerting our on-call technician."}'::jsonb, 'Vireek editorial v1 - standard public-safety guidance summary (not yet reviewed by a licensed professional)', '2026-11-01', NULL, 'US', 0.9, false),
  ('all', 'safety_rule', 'fire_or_smoke', 1, 'Fire or smoke', '{"flag":"fire_or_smoke","guidance":"If you see flames or heavy smoke, get everyone out and call 911 first. I''m alerting our on-call technician."}'::jsonb, 'Vireek editorial v1 - standard public-safety guidance summary (not yet reviewed by a licensed professional)', '2026-11-01', NULL, 'US', 0.9, false),
  ('all', 'safety_rule', 'sparking_or_burning', 1, 'Sparking or burning at electrical equipment', '{"flag":"sparking_or_burning","guidance":"If it''s safe to reach, turn off the breaker for that circuit or the main breaker, and stay away from it. If you see smoke or flames, leave and call 911. I''m alerting our on-call technician."}'::jsonb, 'Vireek editorial v1 - standard public-safety guidance summary (not yet reviewed by a licensed professional)', '2026-11-01', NULL, 'US', 0.9, false),
  ('all', 'safety_rule', 'electric_shock', 1, 'Electric shock', '{"flag":"electric_shock","guidance":"Don''t touch the person or the appliance. If anyone was hurt or feels unwell, call 911. If it''s safe, turn off power at the main breaker. I''m alerting our on-call technician."}'::jsonb, 'Vireek editorial v1 - standard public-safety guidance summary (not yet reviewed by a licensed professional)', '2026-11-01', NULL, 'US', 0.9, false),
  ('all', 'safety_rule', 'downed_line', 1, 'Downed or exposed live line', '{"flag":"downed_line","guidance":"Stay far away from the line and anything touching it, and call 911 and the power utility. I''m alerting our on-call technician."}'::jsonb, 'Vireek editorial v1 - standard public-safety guidance summary (not yet reviewed by a licensed professional)', '2026-11-01', NULL, 'US', 0.9, false),
  ('all', 'safety_rule', 'water_near_electrical', 1, 'Water near electrical equipment', '{"flag":"water_near_electrical","guidance":"Stay away from outlets, panels and anything electrical near the water. If you can reach the main breaker safely and dry, turn it off. I''m alerting our on-call technician."}'::jsonb, 'Vireek editorial v1 - standard public-safety guidance summary (not yet reviewed by a licensed professional)', '2026-11-01', NULL, 'US', 0.9, false),
  ('all', 'safety_rule', 'active_flooding', 1, 'Active flooding or burst pipe', '{"flag":"active_flooding","guidance":"If you can do it safely, shut off the main water valve and stay away from electrical items near standing water. I''m alerting our on-call technician."}'::jsonb, 'Vireek editorial v1 - standard public-safety guidance summary (not yet reviewed by a licensed professional)', '2026-11-01', NULL, 'US', 0.9, false),
  ('all', 'safety_rule', 'sewage_backup', 1, 'Sewage backup', '{"flag":"sewage_backup","guidance":"Avoid contact with the water and don''t use fixtures that drain into that line. I''m alerting our on-call technician."}'::jsonb, 'Vireek editorial v1 - standard public-safety guidance summary (not yet reviewed by a licensed professional)', '2026-11-01', NULL, 'US', 0.9, false),
  ('all', 'safety_rule', 'no_heat_freezing', 1, 'No heat in freezing weather', '{"flag":"no_heat_freezing","guidance":"I''m flagging this as an emergency for our on-call team. Keep everyone warm in one room, and if anyone feels unwell call 911."}'::jsonb, 'Vireek editorial v1 - standard public-safety guidance summary (not yet reviewed by a licensed professional)', '2026-11-01', NULL, 'US', 0.9, false),
  ('all', 'safety_rule', 'vulnerable_occupant_no_climate', 1, 'No heating or cooling with a vulnerable occupant', '{"flag":"vulnerable_occupant_no_climate","guidance":"I''m flagging this as an emergency for our on-call team. Move everyone vulnerable to a safe temperature, and if anyone feels unwell call 911."}'::jsonb, 'Vireek editorial v1 - standard public-safety guidance summary (not yet reviewed by a licensed professional)', '2026-11-01', NULL, 'US', 0.9, false),
  ('all', 'safety_rule', 'caller_declared_emergency', 1, 'Caller declared an emergency', '{"flag":"caller_declared_emergency","guidance":"I''m flagging this as an emergency and alerting our on-call technician right now."}'::jsonb, 'Vireek editorial v1 - standard public-safety guidance summary (not yet reviewed by a licensed professional)', '2026-11-01', NULL, 'US', 0.9, false),
  ('hvac', 'symptom', 'no_cooling', 1, 'AC running but not cooling', '{"synonyms":["ac not cooling","air conditioner not cooling","ac blowing warm air","ac blows warm","no cold air","not cooling","house wont cool","ac isnt cooling well","ac not cooling well","ac running but warm","ac no cold","air not cold","not making cold","only warm wind","only warm air","ac is warm","air conditioner not cold"],"causes":[{"cause":"Dirty filter or restricted airflow","likelihood":"high"},{"cause":"Low refrigerant charge (leak)","likelihood":"medium"},{"cause":"Failed capacitor or condenser fan motor","likelihood":"medium"},{"cause":"Dirty condenser coil","likelihood":"medium"}],"checks":["Check filter condition","Check thermostat mode and setpoint","Verify outdoor unit running and fan spinning","Measure supply/return temperature split","Check refrigerant pressures and superheat/subcool"],"parts":["Run/start capacitor","Condenser fan motor","Air filter"],"laborHours":{"min":0.5,"max":3},"urgency":"urgent","escalateIf":["Occupant is elderly, an infant or medically vulnerable in extreme heat"]}'::jsonb, 'Vireek editorial v1 - standard trade practice summary (not yet reviewed by a licensed professional)', '2026-11-01', NULL, 'US', 0.7, false),
  ('hvac', 'symptom', 'no_heat', 1, 'Heating not working', '{"synonyms":["no heat","heater not working","furnace not working","furnace not heating","heat not working","heater no work","furnace wont turn on","heat wont come on","furnace stopped","furnace is out","no warm air","boiler not working"],"causes":[{"cause":"Ignition or flame-sensor fault","likelihood":"high"},{"cause":"Thermostat fault or batteries","likelihood":"medium"},{"cause":"Safety lockout (limit/pressure switch)","likelihood":"medium"},{"cause":"Gas or power supply interruption","likelihood":"low"}],"checks":["Check thermostat mode, setpoint, batteries","Check power switch and breaker at the furnace","Check error code on the control board","Inspect flame sensor and ignitor","Check gas supply and venting"],"parts":["Flame sensor","Hot-surface ignitor","Pressure switch","Control board"],"laborHours":{"min":0.5,"max":3},"urgency":"urgent","escalateIf":["Outdoor temperature at or below freezing","Gas odor reported","Vulnerable occupant"]}'::jsonb, 'Vireek editorial v1 - standard trade practice summary (not yet reviewed by a licensed professional)', '2026-11-01', NULL, 'US', 0.7, false),
  ('hvac', 'symptom', 'ac_freezing_up', 1, 'AC or evaporator coil icing over', '{"synonyms":["ac freezing up","ice on ac","ice on the unit","frozen evaporator","ac frozen","ice on the coil","ice on refrigerant line","ice on the pipe outside","ice all over","ice on the ac","ice on the outdoor unit","ice on my ac"],"causes":[{"cause":"Restricted airflow (filter, blower)","likelihood":"high"},{"cause":"Low refrigerant charge","likelihood":"medium"},{"cause":"Failed blower motor","likelihood":"low"}],"checks":["Turn system off and let it thaw","Check filter and return airflow","Check blower operation","Check refrigerant charge after thaw"],"parts":["Air filter","Blower motor","Blower capacitor"],"laborHours":{"min":1,"max":3},"urgency":"urgent"}'::jsonb, 'Vireek editorial v1 - standard trade practice summary (not yet reviewed by a licensed professional)', '2026-11-01', NULL, 'US', 0.7, false),
  ('hvac', 'symptom', 'short_cycling', 1, 'System turns on and off repeatedly', '{"synonyms":["short cycling","turns on and off","keeps turning on and off","starts and stops","cycles on and off","runs few minutes then stops","shuts off after a few minutes"],"causes":[{"cause":"Overheating from restricted airflow","likelihood":"high"},{"cause":"Oversized system or thermostat placement","likelihood":"medium"},{"cause":"Failing flame sensor or limit switch","likelihood":"medium"}],"checks":["Check filter and airflow","Check thermostat location and settings","Check limit switch and flame sensor","Check refrigerant pressures"],"parts":["Flame sensor","Limit switch","Air filter"],"laborHours":{"min":0.5,"max":2.5},"urgency":"routine"}'::jsonb, 'Vireek editorial v1 - standard trade practice summary (not yet reviewed by a licensed professional)', '2026-11-01', NULL, 'US', 0.7, false),
  ('hvac', 'symptom', 'weak_airflow', 1, 'Weak airflow from vents', '{"synonyms":["weak airflow","low airflow","air barely coming out","vents weak","not much air from vents","little air coming out","poor airflow"],"causes":[{"cause":"Dirty filter or coil","likelihood":"high"},{"cause":"Blower motor or capacitor weakening","likelihood":"medium"},{"cause":"Duct restriction or leak","likelihood":"medium"}],"checks":["Check filter","Check blower speed setting and capacitor","Check duct dampers and obvious duct damage","Check evaporator coil"],"parts":["Air filter","Blower capacitor","Blower motor"],"laborHours":{"min":0.5,"max":2.5},"urgency":"routine"}'::jsonb, 'Vireek editorial v1 - standard trade practice summary (not yet reviewed by a licensed professional)', '2026-11-01', NULL, 'US', 0.7, false),
  ('hvac', 'symptom', 'condensate_leak', 1, 'Water leaking from indoor unit', '{"synonyms":["ac leaking water","water leaking from ac","water under furnace","water dripping from air handler","ac dripping inside","water from vent","drain line clogged","condensate leak"],"causes":[{"cause":"Clogged condensate drain line","likelihood":"high"},{"cause":"Cracked or overflowing drain pan","likelihood":"medium"},{"cause":"Frozen coil melting","likelihood":"medium"}],"checks":["Inspect drain line and trap","Inspect drain pan","Check float switch","Check for coil icing"],"parts":["Condensate float switch","Drain pan"],"laborHours":{"min":0.5,"max":2},"urgency":"urgent"}'::jsonb, 'Vireek editorial v1 - standard trade practice summary (not yet reviewed by a licensed professional)', '2026-11-01', NULL, 'US', 0.7, false),
  ('hvac', 'symptom', 'outdoor_unit_noise', 1, 'Loud noise from outdoor unit', '{"synonyms":["outdoor unit loud","ac making loud noise","banging from outside unit","outside unit buzzing","ac humming but not starting","grinding noise from ac","unit outside is noisy","squealing from ac","outdoor unit is making","loud banging noise","loud noise from the unit","banging noise","outdoor unit banging"],"causes":[{"cause":"Failing condenser fan motor or bearings","likelihood":"medium"},{"cause":"Failing capacitor (hum without start)","likelihood":"high"},{"cause":"Loose panel or debris","likelihood":"medium"},{"cause":"Compressor mechanical issue","likelihood":"low"}],"checks":["Inspect fan blade and debris","Test capacitor","Check amp draw on compressor and fan","Check mounting and panels"],"parts":["Run capacitor","Condenser fan motor","Contactor"],"laborHours":{"min":0.5,"max":3},"urgency":"urgent"}'::jsonb, 'Vireek editorial v1 - standard trade practice summary (not yet reviewed by a licensed professional)', '2026-11-01', NULL, 'US', 0.7, false),
  ('hvac', 'symptom', 'thermostat_blank', 1, 'Thermostat blank or unresponsive', '{"synonyms":["thermostat blank","thermostat not working","thermostat screen dead","thermostat no power","thermostat wont turn on","thermostat is dead","thermostat screen is blank","thermostat screen blank"],"causes":[{"cause":"Dead batteries","likelihood":"high"},{"cause":"Tripped float switch or blown low-voltage fuse","likelihood":"medium"},{"cause":"Failed transformer","likelihood":"low"}],"checks":["Replace batteries","Check low-voltage fuse and float switch","Check transformer output"],"parts":["Thermostat","Low-voltage fuse","Transformer"],"laborHours":{"min":0.5,"max":1.5},"urgency":"routine"}'::jsonb, 'Vireek editorial v1 - standard trade practice summary (not yet reviewed by a licensed professional)', '2026-11-01', NULL, 'US', 0.7, false),
  ('hvac', 'symptom', 'pilot_or_ignition_failure', 1, 'Furnace clicks but does not light', '{"synonyms":["furnace clicking","furnace clicks but no flame","furnace wont ignite","pilot light out","pilot wont stay lit","furnace tries to start then stops","burner wont light"],"causes":[{"cause":"Dirty flame sensor","likelihood":"high"},{"cause":"Failed ignitor","likelihood":"medium"},{"cause":"Gas valve or supply problem","likelihood":"low"}],"checks":["Read control-board error code","Inspect flame sensor and ignitor","Verify gas supply and valve","Check venting and pressure switch"],"parts":["Flame sensor","Hot-surface ignitor","Gas valve"],"laborHours":{"min":0.5,"max":2.5},"urgency":"urgent","escalateIf":["Gas odor reported"]}'::jsonb, 'Vireek editorial v1 - standard trade practice summary (not yet reviewed by a licensed professional)', '2026-11-01', NULL, 'US', 0.7, false),
  ('plumbing', 'symptom', 'clogged_drain', 1, 'Slow or clogged drain', '{"synonyms":["clogged drain","drain clogged","drain is slow","sink wont drain","tub wont drain","shower wont drain","water not going down","water not going","sink backed up","toilet is not going down","sink is making stuck","drain blocked","drain is stopped","drains slowly","sink drains slowly","slow sink","drain cleaning"],"causes":[{"cause":"Local blockage (hair, grease, debris)","likelihood":"high"},{"cause":"Main line blockage if several fixtures are affected","likelihood":"medium"}],"checks":["Identify whether one fixture or several are affected","Snake the fixture drain","Camera-inspect the line if it recurs"],"parts":["P-trap","Cleanout cap"],"laborHours":{"min":0.5,"max":2},"urgency":"routine","escalateIf":["Multiple fixtures backing up or sewage visible"]}'::jsonb, 'Vireek editorial v1 - standard trade practice summary (not yet reviewed by a licensed professional)', '2026-11-01', NULL, 'US', 0.7, false),
  ('plumbing', 'symptom', 'no_hot_water', 1, 'No hot water', '{"synonyms":["no hot water","water heater not working","water is cold","only cold water","hot water gone","water not getting hot","no warm water","water heater no heat","hot water finished","hot water is gone","not producing hot water","isnt producing hot water","not getting any hot water","not making hot water","hot water not working","only cold water coming"],"causes":[{"cause":"Gas unit: pilot/thermocouple or burner fault","likelihood":"high"},{"cause":"Electric unit: failed heating element or thermostat, tripped breaker","likelihood":"high"},{"cause":"Sediment buildup reducing capacity","likelihood":"medium"}],"checks":["Determine gas vs electric unit","Check breaker or pilot status","Check thermostat setting","Inspect for leaks at tank"],"parts":["Heating element","Thermostat","Thermocouple"],"laborHours":{"min":1,"max":3},"urgency":"urgent","escalateIf":["Gas odor reported","Water pooling around the tank"]}'::jsonb, 'Vireek editorial v1 - standard trade practice summary (not yet reviewed by a licensed professional)', '2026-11-01', NULL, 'US', 0.7, false),
  ('plumbing', 'symptom', 'water_heater_leaking', 1, 'Water heater leaking', '{"synonyms":["water heater leaking","water heater is leaking","leak from water heater","water around water heater","tank leaking","water pooling by water heater","hot water tank leaking"],"causes":[{"cause":"Failed fitting or relief valve discharge","likelihood":"medium"},{"cause":"Tank corrosion (typically requires replacement)","likelihood":"medium"}],"checks":["Locate the source of the water","Shut off water supply and power/gas to the unit if leaking heavily","Inspect T&P valve and fittings"],"parts":["T&P relief valve","Supply connectors"],"laborHours":{"min":1,"max":4},"urgency":"urgent","escalateIf":["Water is flowing heavily"]}'::jsonb, 'Vireek editorial v1 - standard trade practice summary (not yet reviewed by a licensed professional)', '2026-11-01', NULL, 'US', 0.7, false),
  ('plumbing', 'symptom', 'running_toilet', 1, 'Toilet keeps running', '{"synonyms":["toilet running","toilet keeps running","running toilet","toilet wont stop running","toilet runs all the time","toilet constantly running","toilet hissing","inodoro corriendo","toilet always running"],"causes":[{"cause":"Worn flapper","likelihood":"high"},{"cause":"Faulty fill valve","likelihood":"high"},{"cause":"Incorrect water level or chain","likelihood":"medium"}],"checks":["Dye test for flapper leak","Check fill valve and float","Check chain slack"],"parts":["Flapper","Fill valve"],"laborHours":{"min":0.5,"max":1},"urgency":"routine"}'::jsonb, 'Vireek editorial v1 - standard trade practice summary (not yet reviewed by a licensed professional)', '2026-11-01', NULL, 'US', 0.7, false),
  ('plumbing', 'symptom', 'low_water_pressure', 1, 'Low water pressure', '{"synonyms":["low water pressure","weak water pressure","water pressure is low","water barely coming out","shower pressure weak","no water pressure","trickle from faucet"],"causes":[{"cause":"Clogged aerators or fixture cartridges","likelihood":"high"},{"cause":"Partially closed or failing shutoff or pressure regulator","likelihood":"medium"},{"cause":"Supply-line corrosion or leak","likelihood":"low"}],"checks":["Determine if one fixture or the whole house","Check main shutoff and pressure regulator","Measure static pressure with a gauge"],"parts":["Pressure regulator","Faucet aerator"],"laborHours":{"min":0.5,"max":3},"urgency":"routine"}'::jsonb, 'Vireek editorial v1 - standard trade practice summary (not yet reviewed by a licensed professional)', '2026-11-01', NULL, 'US', 0.7, false),
  ('plumbing', 'symptom', 'sewer_odor', 1, 'Sewer smell indoors', '{"synonyms":["sewer smell","smells like sewage","sewage smell","bad smell from drain","rotten smell from drain","drain smells","smells like sewer"],"causes":[{"cause":"Dry P-trap on a seldom-used fixture","likelihood":"high"},{"cause":"Failed wax ring or vent problem","likelihood":"medium"},{"cause":"Partial main-line blockage","likelihood":"low"}],"checks":["Run water in rarely used drains","Check toilet seal","Check vent terminations","Camera-inspect if persistent"],"parts":["Wax ring","P-trap"],"laborHours":{"min":0.5,"max":3},"urgency":"routine","escalateIf":["Odor smells like rotten eggs and may be gas rather than sewer"]}'::jsonb, 'Vireek editorial v1 - standard trade practice summary (not yet reviewed by a licensed professional)', '2026-11-01', NULL, 'US', 0.7, false),
  ('plumbing', 'symptom', 'garbage_disposal_jam', 1, 'Garbage disposal jammed or humming', '{"synonyms":["garbage disposal not working","disposal humming","disposal jammed","disposal wont spin","garbage disposal stuck","disposal is stuck","garbage disposal is humming","disposal humming"],"causes":[{"cause":"Jammed flywheel","likelihood":"high"},{"cause":"Tripped reset button or failed motor","likelihood":"medium"}],"checks":["Power off before inspecting","Rotate flywheel with the wrench slot","Check reset button"],"parts":["Disposal unit","Flange kit"],"laborHours":{"min":0.5,"max":2},"urgency":"routine"}'::jsonb, 'Vireek editorial v1 - standard trade practice summary (not yet reviewed by a licensed professional)', '2026-11-01', NULL, 'US', 0.7, false),
  ('plumbing', 'symptom', 'dripping_faucet', 1, 'Dripping faucet', '{"synonyms":["faucet leaking","faucet dripping","dripping faucet","dripping faucet in the bathroom","leaky faucet","faucet drips","faucet wont stop dripping"],"causes":[{"cause":"Worn cartridge, washer or o-ring","likelihood":"high"},{"cause":"Worn valve seat","likelihood":"medium"}],"checks":["Identify faucet type","Inspect cartridge or washer","Confirm no leak at supply connections"],"parts":["Faucet cartridge","O-ring kit"],"laborHours":{"min":0.5,"max":1.5},"urgency":"routine","escalateIf":["Water spraying or flowing, not dripping"]}'::jsonb, 'Vireek editorial v1 - standard trade practice summary (not yet reviewed by a licensed professional)', '2026-11-01', NULL, 'US', 0.7, false),
  ('plumbing', 'symptom', 'leaking_pipe_or_faucet', 1, 'Leaking pipe, faucet or fixture', '{"synonyms":["leaking pipe","pipe is leaking","faucet dripping","leak under sink","water under the sink","drip under sink"],"causes":[{"cause":"Worn cartridge, washer or o-ring","likelihood":"high"},{"cause":"Loose or failed supply connection","likelihood":"medium"},{"cause":"Corroded or cracked pipe","likelihood":"low"}],"checks":["Locate source and shut local stop valve","Inspect connections and cartridge","Dry and re-check to confirm source"],"parts":["Faucet cartridge","Supply line","Compression fitting"],"laborHours":{"min":0.5,"max":2.5},"urgency":"urgent","escalateIf":["Water spraying or flowing heavily","Cannot shut off water"]}'::jsonb, 'Vireek editorial v1 - standard trade practice summary (not yet reviewed by a licensed professional)', '2026-11-01', NULL, 'US', 0.7, false),
  ('electrical', 'symptom', 'outlet_dead', 1, 'Outlet or switch not working', '{"synonyms":["outlet not working","outlet dead","outlet has no power","plug not working","switch not working","outlet stopped working","no power at outlet","socket not working","outlet in the living room doesnt work","outlet doesnt work","outlet wont work"],"causes":[{"cause":"Tripped GFCI upstream","likelihood":"high"},{"cause":"Tripped breaker","likelihood":"high"},{"cause":"Loose connection or failed device","likelihood":"medium"}],"checks":["Reset GFCI outlets and check breaker","Test with a known-good load","Inspect device and connections with power off"],"parts":["Receptacle","GFCI receptacle"],"laborHours":{"min":0.5,"max":2},"urgency":"routine","escalateIf":["Burning smell, heat or discoloration at the device"]}'::jsonb, 'Vireek editorial v1 - standard trade practice summary (not yet reviewed by a licensed professional)', '2026-11-01', NULL, 'US', 0.7, false),
  ('electrical', 'symptom', 'breaker_trips', 1, 'Breaker keeps tripping', '{"synonyms":["breaker keeps tripping","breaker trips","breaker wont reset","circuit breaker tripping","breaker keeps going off","fuse keeps blowing","breaker tripped again"],"causes":[{"cause":"Overloaded circuit","likelihood":"high"},{"cause":"Short circuit or ground fault","likelihood":"medium"},{"cause":"Failing breaker","likelihood":"medium"}],"checks":["Identify the load on the circuit","Unplug loads and re-test","Check for heat or damage at the panel and device"],"parts":["Circuit breaker"],"laborHours":{"min":1,"max":3},"urgency":"urgent","escalateIf":["Burning smell or visible damage at the panel"]}'::jsonb, 'Vireek editorial v1 - standard trade practice summary (not yet reviewed by a licensed professional)', '2026-11-01', NULL, 'US', 0.7, false),
  ('electrical', 'symptom', 'flickering_lights', 1, 'Flickering or dimming lights', '{"synonyms":["lights flickering","flickering lights","lights dimming","lights flicker","lights go dim","lights blink","lights keep flickering"],"causes":[{"cause":"Loose bulb, fixture or dimmer incompatibility","likelihood":"high"},{"cause":"Loose neutral or connection in the circuit or panel","likelihood":"medium"},{"cause":"Utility-side voltage problem","likelihood":"low"}],"checks":["Determine whether one fixture or the whole house","Swap bulb and check dimmer type","Inspect connections; check service voltage"],"parts":["Dimmer switch","Light fixture"],"laborHours":{"min":1,"max":3},"urgency":"urgent","escalateIf":["Whole-house flicker combined with burning smell, buzzing or heat"]}'::jsonb, 'Vireek editorial v1 - standard trade practice summary (not yet reviewed by a licensed professional)', '2026-11-01', NULL, 'US', 0.7, false),
  ('electrical', 'symptom', 'panel_buzzing', 1, 'Panel buzzing or hot', '{"synonyms":["panel buzzing","breaker box buzzing","panel is hot","breaker box hot","electrical panel humming","breaker panel noise","buzzing from panel","buzzing from the electrical panel","electrical panel is buzzing","buzzing from the breaker box"],"causes":[{"cause":"Loose lug or failing breaker","likelihood":"medium"},{"cause":"Overloaded or arcing connection","likelihood":"medium"}],"checks":["Do not open the panel cover as a homeowner","Inspect for heat discoloration with proper PPE","Thermal-scan connections"],"parts":["Circuit breaker","Main breaker"],"laborHours":{"min":1,"max":4},"urgency":"urgent","escalateIf":["Burning smell, sparking, smoke or heat at the panel"]}'::jsonb, 'Vireek editorial v1 - standard trade practice summary (not yet reviewed by a licensed professional)', '2026-11-01', NULL, 'US', 0.7, false),
  ('electrical', 'symptom', 'gfci_tripping', 1, 'GFCI keeps tripping', '{"synonyms":["gfci keeps tripping","gfci wont reset","gfci tripping","gfci outlet wont reset","gfci wont reset","gfi wont reset","outlet wont reset","reset button wont stay","outdoor outlet keeps tripping"],"causes":[{"cause":"Moisture in the circuit or device","likelihood":"high"},{"cause":"Failing GFCI device","likelihood":"medium"},{"cause":"Ground fault in connected appliance","likelihood":"medium"}],"checks":["Unplug all loads and reset","Inspect for moisture","Test GFCI device"],"parts":["GFCI receptacle","Weatherproof cover"],"laborHours":{"min":0.5,"max":2},"urgency":"routine"}'::jsonb, 'Vireek editorial v1 - standard trade practice summary (not yet reviewed by a licensed professional)', '2026-11-01', NULL, 'US', 0.7, false),
  ('electrical', 'symptom', 'partial_power_loss', 1, 'Part of the house has no power', '{"synonyms":["half the house no power","part of house has no power","some outlets dead","room has no power","power out in some rooms","lost power in half the house","half my house is out","half the house has no power","half of my house has no power","no light in half of my house","no light in the half of my house","part of the house has no power"],"causes":[{"cause":"Tripped breaker or one leg of service lost","likelihood":"medium"},{"cause":"Failed main breaker or loose service connection","likelihood":"low"}],"checks":["Check main and branch breakers","Check whether the neighbors are affected (utility)","Measure voltage at the panel with proper PPE"],"parts":["Main breaker","Circuit breaker"],"laborHours":{"min":1,"max":4},"urgency":"urgent"}'::jsonb, 'Vireek editorial v1 - standard trade practice summary (not yet reviewed by a licensed professional)', '2026-11-01', NULL, 'US', 0.7, false),
  ('plumbing', 'permit_trigger', 'water_heater_replacement', 1, 'Water heater replacement', '{"work":"Water heater replacement","synonyms":["replace water heater","new water heater","water heater replacement","install water heater","swapping out water heater","swap water heater","swapping water heater","change out water heater"],"note":"Most US jurisdictions require a permit; the local authority having jurisdiction decides."}'::jsonb, 'Vireek editorial v1 - generic US permit-trigger heuristic; the local authority having jurisdiction decides', '2026-11-01', NULL, 'US', 0.6, false),
  ('hvac', 'permit_trigger', 'equipment_replacement', 1, 'Furnace or AC replacement', '{"work":"HVAC equipment replacement","synonyms":["replace furnace","new furnace","replace ac","new ac","new air conditioner","replace air conditioner","install furnace","install ac","new heat pump"],"note":"Most US jurisdictions require a mechanical permit for changeouts; the local authority having jurisdiction decides."}'::jsonb, 'Vireek editorial v1 - generic US permit-trigger heuristic; the local authority having jurisdiction decides', '2026-11-01', NULL, 'US', 0.6, false),
  ('electrical', 'permit_trigger', 'panel_upgrade', 1, 'Electrical panel upgrade or replacement', '{"work":"Service panel work","synonyms":["panel upgrade","replace panel","new panel","upgrade electrical panel","200 amp service","replace breaker panel","upgrade service"],"note":"Panel and service work almost always requires an electrical permit and inspection; the local authority having jurisdiction decides."}'::jsonb, 'Vireek editorial v1 - generic US permit-trigger heuristic; the local authority having jurisdiction decides', '2026-11-01', NULL, 'US', 0.6, false),
  ('electrical', 'permit_trigger', 'new_circuit', 1, 'New circuit or outlet installation', '{"work":"New circuits","synonyms":["new circuit","add outlet","install new outlet","add a circuit","ev charger install","install ev charger","add a 240 outlet"],"note":"New circuits commonly require a permit; the local authority having jurisdiction decides."}'::jsonb, 'Vireek editorial v1 - generic US permit-trigger heuristic; the local authority having jurisdiction decides', '2026-11-01', NULL, 'US', 0.6, false),
  ('plumbing', 'permit_trigger', 'gas_line_work', 1, 'Gas line installation or modification', '{"work":"Gas piping","synonyms":["new gas line","move gas line","gas line install","run a gas line","gas stove hookup","gas range hookup","gas piping"],"note":"Gas piping work typically requires a permit and pressure test; the local authority having jurisdiction decides."}'::jsonb, 'Vireek editorial v1 - generic US permit-trigger heuristic; the local authority having jurisdiction decides', '2026-11-01', NULL, 'US', 0.6, false),
  ('plumbing', 'permit_trigger', 'repipe', 1, 'Whole-house repipe', '{"work":"Repiping","synonyms":["repipe","re-pipe","replace all the pipes","whole house repipe","replace main water line","new water main"],"note":"Repiping commonly requires a plumbing permit; the local authority having jurisdiction decides."}'::jsonb, 'Vireek editorial v1 - generic US permit-trigger heuristic; the local authority having jurisdiction decides', '2026-11-01', NULL, 'US', 0.6, false)
ON CONFLICT (trade, kind, key, version, jurisdiction) DO NOTHING;

-- =============================================================
-- 2. OUTCOME EVENTS (per tenant)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.vertical_outcome_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('diagnosis', 'price', 'parts')),
  subject_type text NOT NULL CHECK (subject_type IN ('job', 'call', 'quote', 'diagnosis_session')),
  subject_id text NOT NULL CHECK (char_length(subject_id) BETWEEN 1 AND 128),
  -- Contracts (see supabase/functions/_shared/vertical-ai/outcomeEvents.ts):
  --   diagnosis: predicted {"cause_keys":[...],"symptom_key":"..."}  confirmed {"cause_key":"..."}
  --   price:     predicted {"quoted_cents":int}                       confirmed {"final_cents":int}
  --   parts:     predicted {"parts":[...]}                            confirmed {"parts":[...]}
  predicted jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(predicted) = 'object' AND pg_column_size(predicted) <= 8192),
  confirmed jsonb CHECK (confirmed IS NULL OR (jsonb_typeof(confirmed) = 'object' AND pg_column_size(confirmed) <= 8192)),
  evidence_ids text[] NOT NULL DEFAULT '{}' CHECK (cardinality(evidence_ids) <= 32),
  predicted_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  UNIQUE (user_id, kind, subject_type, subject_id),
  CHECK ((confirmed IS NULL) = (confirmed_at IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_vertical_outcome_events_user_kind
  ON public.vertical_outcome_events (user_id, kind, predicted_at DESC);

ALTER TABLE public.vertical_outcome_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_vertical_outcome_events" ON public.vertical_outcome_events;
CREATE POLICY "select_own_vertical_outcome_events" ON public.vertical_outcome_events
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.vertical_outcome_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.vertical_outcome_events FROM anon;

-- =============================================================
-- 3. WRITERS (service_role only; idempotent)
-- =============================================================
CREATE OR REPLACE FUNCTION public.record_vertical_prediction(
  p_user_id uuid, p_kind text, p_subject_type text, p_subject_id text, p_predicted jsonb, p_evidence_ids text[] DEFAULT '{}'
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'user_id required'; END IF;
  INSERT INTO public.vertical_outcome_events (user_id, kind, subject_type, subject_id, predicted, evidence_ids)
  VALUES (p_user_id, p_kind, p_subject_type, p_subject_id, COALESCE(p_predicted, '{}'::jsonb), COALESCE(p_evidence_ids, '{}'))
  ON CONFLICT (user_id, kind, subject_type, subject_id) DO UPDATE
    SET predicted = EXCLUDED.predicted, evidence_ids = EXCLUDED.evidence_ids, predicted_at = now()
    WHERE public.vertical_outcome_events.confirmed_at IS NULL   -- a confirmed record is immutable ground truth
  RETURNING id INTO v_id;
  RETURN v_id;  -- NULL when the record was already confirmed and was left untouched
END;
$$;

CREATE OR REPLACE FUNCTION public.record_vertical_confirmation(
  p_user_id uuid, p_kind text, p_subject_type text, p_subject_id text, p_confirmed jsonb
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n integer;
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'user_id required'; END IF;
  IF p_confirmed IS NULL OR jsonb_typeof(p_confirmed) <> 'object' THEN RAISE EXCEPTION 'confirmed must be a json object'; END IF;
  UPDATE public.vertical_outcome_events
     SET confirmed = p_confirmed, confirmed_at = now()
   WHERE user_id = p_user_id AND kind = p_kind AND subject_type = p_subject_type AND subject_id = p_subject_id
     AND confirmed_at IS NULL;                                   -- first confirmation wins; replays are no-ops
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.record_vertical_prediction(uuid, text, text, text, jsonb, text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_vertical_confirmation(uuid, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_vertical_prediction(uuid, text, text, text, jsonb, text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_vertical_confirmation(uuid, text, text, text, jsonb) TO service_role;

-- =============================================================
-- 4. TENANT-SCOPED OBSERVABILITY (call_trace_events is not client-readable, so expose a scoped rollup)
-- =============================================================
CREATE OR REPLACE FUNCTION public.vertical_ai_quality(p_days integer DEFAULT 14)
RETURNS TABLE (day date, name text, events bigint, ok_events bigint, failed_events bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT e.occurred_at::date, e.name, count(*), count(*) FILTER (WHERE e.ok IS TRUE), count(*) FILTER (WHERE e.ok IS FALSE)
    FROM public.call_trace_events e
   WHERE e.user_id = public.get_account_owner_id()
     AND e.name LIKE 'vai\_%' ESCAPE '\'
     AND e.occurred_at >= now() - make_interval(days => GREATEST(1, LEAST(COALESCE(p_days, 14), 90)))
   GROUP BY 1, 2
   ORDER BY 1 DESC, 2;
$$;

CREATE OR REPLACE FUNCTION public.vertical_outcome_accuracy(p_days integer DEFAULT 90)
RETURNS TABLE (kind text, predicted_n bigint, confirmed_n bigint, hit_n bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT v.kind,
         count(*),
         count(*) FILTER (WHERE v.confirmed_at IS NOT NULL),
         count(*) FILTER (WHERE v.confirmed_at IS NOT NULL AND (
           (v.kind = 'diagnosis' AND v.predicted->'cause_keys' ? (v.confirmed->>'cause_key'))
        OR (v.kind = 'price' AND (v.confirmed->>'final_cents') ~ '^[0-9]+$' AND (v.predicted->>'quoted_cents') ~ '^[0-9]+$'
              AND abs((v.confirmed->>'final_cents')::bigint - (v.predicted->>'quoted_cents')::bigint) <= (v.predicted->>'quoted_cents')::bigint * 0.05)
        OR (v.kind = 'parts' AND v.confirmed->'parts' <@ v.predicted->'parts')))
    FROM public.vertical_outcome_events v
   WHERE v.user_id = public.get_account_owner_id()
     AND v.predicted_at >= now() - make_interval(days => GREATEST(1, LEAST(COALESCE(p_days, 90), 365)))
   GROUP BY v.kind
   ORDER BY v.kind;
$$;

REVOKE ALL ON FUNCTION public.vertical_ai_quality(integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.vertical_outcome_accuracy(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vertical_ai_quality(integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.vertical_outcome_accuracy(integer) TO authenticated, service_role;

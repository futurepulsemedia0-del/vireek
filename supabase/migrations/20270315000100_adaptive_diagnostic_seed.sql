/*
  # VIREEK Adaptive Diagnostic Network - expert seed knowledge

  Starting beliefs (pseudo-counts) that the network then refines from verified outcomes.
  Weights are "equivalent observations": a likelihood row of 18 means roughly
  "18 of 20 comparable jobs showed this". Verified field outcomes outweigh these seeds
  as they accumulate. Safe to re-run (upserts).

  Extending: add rows to adn_symptoms / adn_causes / adn_tests / adn_seed_priors /
  adn_seed_likelihoods. Any (test, cause) pair with no likelihood row is treated as
  uninformative (uniform).

  Decision support only: technicians must follow manufacturer service data, local code
  and EPA 608 for refrigerant work.
*/

-- ---------------------------------------------------------------
-- Symptoms
-- ---------------------------------------------------------------
INSERT INTO adn_symptoms (key, label, family, trade, keywords, mandatory_test_keys, sort_order) VALUES
  ('ac_not_cooling',        'AC runs but is not cooling (warm air)',       'ac',            'hvac',     ARRAY['warm','not cold','weak cooling','no cooling','ac'], ARRAY[]::text[], 10),
  ('ac_wont_start',         'AC / outdoor unit will not start',            'ac',            'hvac',     ARRAY['not starting','dead','no response','humming','tripped'], ARRAY[]::text[], 11),
  ('ac_freezing',           'Evaporator coil or line freezing up',         'ac',            'hvac',     ARRAY['ice','frozen','freezing','frost'], ARRAY[]::text[], 12),
  ('furnace_no_heat',       'Furnace not producing heat',                  'furnace',       'hvac',     ARRAY['no heat','cold','will not ignite','lockout'], ARRAY['fur_safety_check'], 20),
  ('furnace_short_cycling', 'Furnace short cycles / shuts off early',      'furnace',       'hvac',     ARRAY['short cycle','turns off','limit','cycling'], ARRAY['fur_safety_check'], 21),
  ('wh_no_hot_water',       'Water heater: no hot water',                  'water_heater',  'plumbing', ARRAY['no hot water','cold water','pilot'], ARRAY['wh_safety_check'], 30),
  ('wh_not_enough_hot',     'Water heater: runs out fast / lukewarm',      'water_heater',  'plumbing', ARRAY['lukewarm','runs out','not hot enough'], ARRAY['wh_safety_check'], 31),
  ('drain_slow_or_blocked', 'Slow drain or blockage',                      'plumbing_drain','plumbing', ARRAY['clog','slow drain','backup','gurgling'], ARRAY[]::text[], 40)
ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, family = EXCLUDED.family, trade = EXCLUDED.trade,
  keywords = EXCLUDED.keywords, mandatory_test_keys = EXCLUDED.mandatory_test_keys, sort_order = EXCLUDED.sort_order;

-- ---------------------------------------------------------------
-- Causes (with repair path + likely parts)
-- ---------------------------------------------------------------
INSERT INTO adn_causes (key, label, family, safety_critical, summary, repair_steps, parts) VALUES
-- AC / heat pump (cooling)
('ac_low_charge','Low refrigerant charge (leak)','ac',false,'System is undercharged, almost always from a leak.',
 '["Locate and repair the leak (electronic detector, bubble solution, UV dye); do not top off without repairing.","Recover remaining refrigerant per EPA 608; evacuate to 500 microns and hold.","Replace the filter drier, then weigh in the factory charge and verify against manufacturer subcooling or superheat targets.","Re-test pressures, temperature split and amp draw after 15 minutes of runtime."]',
 '[{"name":"Filter drier","necessity":"likely"},{"name":"Refrigerant (type per nameplate)","necessity":"likely"},{"name":"Brazing materials","necessity":"possible"},{"name":"Evaporator coil","necessity":"if_confirmed"}]'),
('ac_dirty_evap','Dirty evaporator coil','ac',false,'Coil fouling reduces airflow and heat transfer.',
 '["Power off and lock out; remove the access panel.","Clean the coil with an approved coil cleaner and flush the condensate pan and drain line.","Replace the filter and confirm the drain flows freely.","Restore power; verify temperature split, suction pressure and airflow."]',
 '[{"name":"Coil cleaner","necessity":"likely"},{"name":"Air filter","necessity":"likely"},{"name":"Drain treatment","necessity":"possible"}]'),
('ac_restricted_airflow','Restricted airflow (filter, return, ducts)','ac',false,'Loaded filter or blocked return/duct limits airflow across the coil.',
 '["Replace or clean the filter; check return grille and duct restrictions.","Check the blower wheel for debris; verify blower speed tap and static pressure against manufacturer limits.","Clear ducts, dampers and closed registers.","Verify temperature split and coil temperatures once airflow is restored."]',
 '[{"name":"Air filter","necessity":"likely"}]'),
('ac_failed_blower','Indoor blower weak or failed (motor / capacitor)','ac',false,'Indoor blower is not moving enough air.',
 '["Power off and lock out; discharge the capacitor.","Test the blower capacitor and motor windings; check for seized bearings.","Replace the failed capacitor or motor with the exact nameplate specification.","Clean the blower wheel; verify airflow and amp draw."]',
 '[{"name":"Blower capacitor","necessity":"likely"},{"name":"Blower motor","necessity":"if_confirmed"}]'),
('ac_dirty_condenser','Dirty or blocked condenser coil','ac',false,'Poor heat rejection raises head pressure and cuts capacity.',
 '["Power off and lock out the outdoor unit.","Clear debris and wash the condenser coil from the inside out with a coil-safe cleaner.","Verify the fan spins freely and restore clearance around the unit.","Re-test head pressure, subcooling and amp draw."]',
 '[{"name":"Coil cleaner","necessity":"likely"}]'),
('ac_condenser_fan_failure','Condenser fan motor failure','ac',false,'Outdoor fan is not moving air; compressor overheats or trips.',
 '["Power off, lock out and discharge the capacitor.","Test fan motor windings and the dual-run capacitor; check the blade spins freely.","Replace the motor (and capacitor) with the exact horsepower, RPM, rotation and voltage.","Run the unit and verify head pressure and amp draw."]',
 '[{"name":"Condenser fan motor","necessity":"likely"},{"name":"Dual-run capacitor","necessity":"likely"}]'),
('ac_weak_compressor','Weak compressor (internal valve wear)','ac',false,'Compressor is not pumping efficiently: high suction, low head, low amps.',
 '["Confirm with gauges after ruling out low charge and (heat pump) a failed reversing valve.","Quote repair vs replacement; check warranty status and system age.","If replacing: recover refrigerant, replace compressor and filter drier; flush if burnout is suspected.","Evacuate, weigh in the charge and verify operating pressures and temperature split."]',
 '[{"name":"Compressor","necessity":"if_confirmed"},{"name":"Filter drier","necessity":"likely"},{"name":"Refrigerant","necessity":"likely"}]'),
('ac_metering_restriction','Metering device or liquid line restriction','ac',false,'Restriction starves the evaporator: low suction, high superheat, high subcooling.',
 '["Confirm the readings and rule out low charge.","Recover refrigerant; inspect and replace the metering device or clear/replace the restricted drier or kinked line.","Replace the filter drier, evacuate, and weigh in the charge.","Verify superheat/subcooling and temperature split."]',
 '[{"name":"TXV or piston metering device","necessity":"likely"},{"name":"Filter drier","necessity":"likely"}]'),
('ac_overcharge','Refrigerant overcharge','ac',false,'Too much refrigerant: high head pressure, high subcooling, low superheat.',
 '["Verify airflow and condenser condition are normal first.","Recover refrigerant gradually to the manufacturer target subcooling or superheat.","Re-check head pressure, amp draw and temperature split."]',
 '[]'),
('ac_failed_run_capacitor','Failed run capacitor','ac',false,'Compressor or fan cannot start or runs weak.',
 '["Power off, lock out and safely discharge the capacitor.","Measure microfarads against the rating label; replace if out of tolerance or swollen.","Install the same microfarad and voltage rating.","Restore power and verify compressor and fan amp draw."]',
 '[{"name":"Run capacitor (match uF and voltage)","necessity":"likely"},{"name":"Contactor","necessity":"possible"}]'),
('ac_failed_contactor','Failed or pitted contactor','ac',false,'Contacts do not close or are burnt, so the outdoor unit gets no power.',
 '["Power off and lock out.","Inspect contacts for pitting or burning and verify 24V coil pull-in.","Replace with the same pole count, coil voltage and amperage rating; check capacitor and wiring for heat damage.","Verify clean pull-in and amp draw."]',
 '[{"name":"Contactor","necessity":"likely"},{"name":"Run capacitor","necessity":"possible"}]'),
('ac_no_line_power','No line power to outdoor unit (breaker / disconnect / fuses)','ac',false,'High-voltage supply is open.',
 '["Check the disconnect, fuses and breaker; find out why it tripped before resetting.","Measure line voltage at the contactor line side.","Repair the supply fault; if a breaker trips repeatedly, test for a ground fault or shorted compressor and do not keep resetting."]',
 '[{"name":"Disconnect fuses","necessity":"possible"}]'),
('ac_no_control_signal','Low-voltage circuit open (fuse, transformer, float switch)','ac',false,'No 24V control signal reaches the contactor.',
 '["Check the condensate float switch and clear the drain if tripped.","Check the low-voltage fuse and transformer output (about 24V).","Look for a shorted thermostat wire before replacing the fuse or transformer."]',
 '[{"name":"Low-voltage fuse","necessity":"likely"},{"name":"Transformer","necessity":"possible"},{"name":"Float switch","necessity":"possible"}]'),
('ac_thermostat_fault','Thermostat fault or wrong settings','ac',false,'Thermostat is not calling for cooling.',
 '["Verify mode, setpoint, batteries and wiring at the thermostat.","Jumper R to Y at the air handler to confirm the system responds.","Replace or reprogram the thermostat; verify it calls and stops at setpoint."]',
 '[{"name":"Thermostat","necessity":"likely"},{"name":"Batteries","necessity":"possible"}]'),
('ac_compressor_failure','Compressor failure (seized, open or grounded winding)','ac',false,'Compressor will not run or trips on overload.',
 '["Check windings to ground and between terminals (power off, lock out).","Confirm capacitor and contactor are good before condemning the compressor.","Quote repair vs replacement; if replacing, recover refrigerant, change the drier, test oil for acid and flush if burnout.","Evacuate and weigh in the charge; verify amp draw and pressures."]',
 '[{"name":"Compressor","necessity":"if_confirmed"},{"name":"Filter drier","necessity":"likely"}]'),
-- Gas furnace
('fur_no_power','No power (service switch, breaker, door switch)','furnace',false,'Furnace has no 120V or 24V supply.',
 '["Verify the service switch, breaker and blower door switch.","Measure 120V at the board and 24V at the transformer secondary.","Replace the failed switch, fuse or transformer; investigate why a breaker tripped."]',
 '[{"name":"Door switch","necessity":"possible"},{"name":"Board fuse","necessity":"possible"},{"name":"Transformer","necessity":"possible"}]'),
('fur_thermostat','Thermostat fault or wrong settings','furnace',false,'No call for heat reaches the furnace.',
 '["Check mode, setpoint, batteries and wiring.","Jumper R to W at the board to confirm the furnace runs.","Replace the thermostat if the furnace responds to the jumper."]',
 '[{"name":"Thermostat","necessity":"likely"}]'),
('fur_igniter','Failed hot surface igniter','furnace',false,'Igniter does not glow, so burners cannot light.',
 '["Power off and gas off; inspect the igniter for cracks.","Check igniter resistance against the manufacturer range.","Replace the igniter (handle by the base only), restore gas and power and verify a full ignition sequence."]',
 '[{"name":"Hot surface igniter","necessity":"likely"}]'),
('fur_flame_sensor','Dirty or failed flame sensor','furnace',false,'Burners light then shut off because flame is not sensed.',
 '["Power off; remove the flame sensor and clean gently with a fine abrasive pad.","Check the ceramic for cracks, the wire and the ground connection.","Measure flame signal in microamps while burning; replace the sensor if low after cleaning."]',
 '[{"name":"Flame sensor","necessity":"likely"}]'),
('fur_inducer','Inducer motor failure','furnace',false,'Draft inducer does not run, so the sequence stops.',
 '["Power off; verify 120V to the inducer on a call for heat.","Check bearings, capacitor (if equipped) and the wheel for debris.","Replace the inducer assembly with the exact model; confirm the pressure switch closes."]',
 '[{"name":"Inducer motor assembly","necessity":"likely"},{"name":"Gasket","necessity":"possible"}]'),
('fur_pressure_switch','Pressure switch fault or blocked vent / condensate','furnace',false,'Pressure switch does not prove draft.',
 '["Inspect the vent, intake and condensate trap/drain for blockage; clear them.","Inspect the pressure switch hose for cracks, water or blockage.","Test switch closure with a manometer against its rated pressure; replace if it fails."]',
 '[{"name":"Pressure switch","necessity":"possible"},{"name":"Pressure hose","necessity":"possible"},{"name":"Condensate trap","necessity":"possible"}]'),
('fur_gas_supply_valve','Gas supply interruption or failed gas valve','furnace',false,'Burners do not light despite a good ignition sequence.',
 '["Confirm the gas shutoff is open and supply pressure is adequate (licensed work only).","Verify 24V at the gas valve during trial for ignition.","Replace the valve if 24V is present and it does not open; check manifold pressure against the data plate. Gas work must follow local code."]',
 '[{"name":"Gas valve","necessity":"if_confirmed"}]'),
('fur_control_board','Failed control board','furnace',false,'Board does not run the sequence correctly.',
 '["Rule out external causes first: power, thermostat, switches and sensors.","Inspect for burn marks, cracked solder joints or water damage.","Replace with the exact OEM board and verify a full heating cycle."]',
 '[{"name":"Integrated control board","necessity":"if_confirmed"}]'),
('fur_limit_airflow','Overheat limit tripping (dirty filter / weak airflow)','furnace',false,'Limit switch shuts burners because the heat exchanger overheats.',
 '["Replace the dirty filter and check return air restrictions.","Verify blower speed, motor and capacitor; clean the blower wheel.","Check temperature rise against the nameplate range; replace the limit switch only if it trips at normal temperatures."]',
 '[{"name":"Air filter","necessity":"likely"},{"name":"Limit switch","necessity":"possible"}]'),
('fur_blower_failure','Blower motor or capacitor failure','furnace',false,'Not enough air moves across the heat exchanger.',
 '["Power off; test the capacitor and motor windings.","Replace the capacitor or motor with the exact specification.","Verify airflow and temperature rise are within the nameplate range."]',
 '[{"name":"Blower capacitor","necessity":"likely"},{"name":"Blower motor","necessity":"if_confirmed"}]'),
('fur_gas_leak','Gas leak (SAFETY HAZARD)','furnace',true,'Gas odor reported or detected.',
 '["STOP. Evacuate, shut off gas at the meter if safe, and call the gas utility or emergency services.","Do not operate switches, phones or open flames inside the building.","Return only after the utility or a licensed gas fitter has cleared the system."]',
 '[]'),
('fur_cracked_hx','Cracked heat exchanger / CO source (SAFETY HAZARD)','furnace',true,'Combustion gases may enter the airstream.',
 '["Shut down and red-tag the furnace; inform the occupants of the CO risk.","Document findings with photos and a combustion analysis.","Recommend heat exchanger or furnace replacement; do not restart until repaired or replaced."]',
 '[]'),
('fur_venting_co','Venting failure causing CO (SAFETY HAZARD)','furnace',true,'Flue gases are not being exhausted safely.',
 '["Shut down the appliance and ventilate; measure CO with a calibrated analyzer.","Inspect the flue for blockage, disconnection or corrosion and check combustion air supply.","Repair the venting and verify safe CO readings and draft before returning to service."]',
 '[]'),
-- Water heater
('wh_tripped_limit','Tripped breaker or high-limit (ECO) - electric','water_heater',false,'Power or the high-limit safety is open.',
 '["Switch power off; press the ECO reset on the upper thermostat after it cools.","Find why it tripped: failed thermostat, shorted element or wiring fault.","Replace the faulty component before restoring service."]',
 '[{"name":"Thermostat / ECO","necessity":"possible"}]'),
('wh_failed_element','Failed heating element - electric','water_heater',false,'One element is open or shorted.',
 '["Power off at the breaker and verify dead with a meter; drain below the element.","Test resistance/continuity; replace the failed element with the same wattage and voltage.","Refill the tank completely before restoring power to avoid dry-firing."]',
 '[{"name":"Heating element (match wattage and voltage)","necessity":"likely"},{"name":"Element gasket","necessity":"likely"}]'),
('wh_failed_thermostat','Failed thermostat - electric','water_heater',false,'Thermostat does not call for heat correctly.',
 '["Power off; test the thermostat and ECO continuity.","Replace the failed thermostat.","Verify setpoint and that both elements cycle correctly."]',
 '[{"name":"Upper or lower thermostat","necessity":"likely"}]'),
('wh_pilot_thermocouple','Pilot out / failed thermocouple or flame sensor - gas','water_heater',false,'Pilot will not stay lit or burner does not light.',
 '["Gas off; clean the pilot orifice and burner area.","Test thermocouple millivolt output against the manufacturer value.","Replace the thermocouple or flame sensor; relight per the label and verify burner operation."]',
 '[{"name":"Thermocouple or flame sensor","necessity":"likely"}]'),
('wh_gas_control','Failed gas control valve - gas','water_heater',false,'Pilot is lit but the main burner does not open.',
 '["Confirm gas supply and pilot flame.","Check thermopile/thermocouple output and gas control position.","Replace the gas control valve if it fails to open with good signals; licensed gas work required."]',
 '[{"name":"Gas control valve","necessity":"if_confirmed"}]'),
('wh_gas_supply','Gas supply interrupted - gas','water_heater',false,'No gas reaches the appliance.',
 '["Check the shutoff valve at the heater and other gas appliances.","Check the meter and regulator or call the gas utility.","Relight and verify operation after supply is restored."]',
 '[]'),
('wh_dip_tube','Broken dip tube','water_heater',false,'Cold inlet water mixes with hot water at the top of the tank.',
 '["Shut off water and power or gas; drain part of the tank.","Replace the dip tube and verify the inlet fitting.","Flush plastic fragments from fixture aerators."]',
 '[{"name":"Dip tube","necessity":"likely"}]'),
('wh_sediment','Sediment / scale buildup','water_heater',false,'Sediment insulates the heat source and reduces capacity.',
 '["Turn off power or gas and cold water; flush the tank through the drain valve.","Descale if hardness is high; inspect the anode rod.","Recommend annual flushing; consider water treatment."]',
 '[{"name":"Anode rod","necessity":"possible"}]'),
('wh_mixing_valve','Faulty mixing valve or cross-connection','water_heater',false,'Hot and cold supplies are blending incorrectly.',
 '["Test the mixing valve setting and thermal element.","Check for cross-connections (single-lever faucets, recirculation lines, check valves).","Repair or replace the valve or cross-connected fixture."]',
 '[{"name":"Mixing valve","necessity":"possible"}]'),
('wh_gas_leak_co','Gas leak or CO source (SAFETY HAZARD)','water_heater',true,'Gas odor or CO alarm reported.',
 '["STOP. Shut off gas if safe, ventilate and evacuate.","Call the gas utility or emergency services.","Return to service only after a licensed gas fitter clears the appliance and venting."]',
 '[]'),
('wh_tank_failure','Tank leak or failure (SAFETY HAZARD)','water_heater',true,'Water is leaking from the tank.',
 '["Shut off power or gas and the cold water supply; limit water damage.","Confirm the leak source (tank vs fittings vs relief valve).","If the tank has failed, replace the unit; confirm relief valve, expansion tank and venting on the new installation."]',
 '[{"name":"Replacement water heater","necessity":"if_confirmed"}]'),
-- Drains
('dr_trap_clog','Fixture or trap clog','plumbing_drain',false,'Blockage is local to one fixture.',
 '["Clear the P-trap or use a hand auger at the fixture.","Run hot water and verify full flow.","Advise on hair catchers and no-grease disposal."]','[]'),
('dr_branch_clog','Branch line clog','plumbing_drain',false,'Blockage in a branch serving several fixtures.',
 '["Use a drum auger through the nearest cleanout or fixture access.","Flush and confirm all fixtures on the branch drain.","Consider hydro-jetting for recurring grease or scale."]','[]'),
('dr_main_blockage','Main sewer line blockage','plumbing_drain',false,'Whole-house or lowest-fixture backup.',
 '["Open the main cleanout (PPE) and clear with a sewer machine.","Run a camera inspection to find the cause of the blockage.","Document findings and recommend jetting or repair if needed."]','[]'),
('dr_roots','Tree root intrusion','plumbing_drain',false,'Roots entering joints in the sewer line.',
 '["Cut roots with a root-cutting head.","Camera inspect to confirm line condition and entry point.","Recommend scheduled maintenance, root control or spot repair/lining."]','[]'),
('dr_vent_blocked','Blocked plumbing vent','plumbing_drain',false,'Insufficient venting causes slow drains and gurgling.',
 '["Inspect the roof vent for nests or debris and clear it.","Verify gurgling stops and fixtures drain at full rate.","Check the venting configuration for code compliance."]','[]'),
('dr_line_collapse','Collapsed, bellied or offset line','plumbing_drain',false,'Structural defect in the drain line.',
 '["Camera inspect and locate the defect and its depth.","Document with footage.","Quote spot repair, lining or replacement; advise on excavation."]','[]'),
('dr_wipes_grease','Grease or wipes buildup (recurring)','plumbing_drain',false,'Accumulated grease or non-flushable wipes.',
 '["Clear the line by jetting.","Advise on grease and wipes habits.","Offer a maintenance plan with periodic jetting."]','[]')
ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, family = EXCLUDED.family, safety_critical = EXCLUDED.safety_critical,
  summary = EXCLUDED.summary, repair_steps = EXCLUDED.repair_steps, parts = EXCLUDED.parts;

-- ---------------------------------------------------------------
-- Tests / questions
-- ---------------------------------------------------------------
INSERT INTO adn_tests (key, label, question, tool_needed, effort, kind, safety_note, answers) VALUES
-- AC
('ac_outdoor_unit_state','Outdoor unit state','With the thermostat calling for cooling, what is the outdoor unit doing?',NULL,1,'inspection',NULL,
 '[{"key":"all_running","label":"Fan and compressor both running"},{"key":"fan_only","label":"Fan running, compressor not running"},{"key":"compressor_only","label":"Compressor running, fan not spinning"},{"key":"hum_no_start","label":"Compressor humming / clicking but not starting"},{"key":"dead","label":"Nothing running, no hum"}]'),
('ac_indoor_airflow','Indoor airflow','How is the airflow at the supply registers?',NULL,1,'inspection',NULL,
 '[{"key":"normal","label":"Normal"},{"key":"weak","label":"Weak"},{"key":"none","label":"No airflow"}]'),
('ac_filter_coil_visual','Filter and evaporator coil','What do you see at the filter and evaporator coil?',NULL,2,'inspection','Power off and lock out before opening access panels.',
 '[{"key":"clean","label":"Filter and coil look clean"},{"key":"dirty_filter","label":"Filter dirty or loaded"},{"key":"dirty_coil","label":"Evaporator coil visibly dirty"},{"key":"iced","label":"Ice on the coil or suction line"}]'),
('ac_delta_t','Temperature split','What is the temperature split (return minus supply air)?','Dual probe thermometer',1,'measurement',NULL,
 '[{"key":"low","label":"Low (below about 14 F)"},{"key":"normal","label":"Normal (about 14-22 F)"},{"key":"high","label":"High (above about 22 F)"}]'),
('ac_suction_pressure','Suction pressure','How is the suction pressure versus the manufacturer chart for current conditions?','Manifold gauges',3,'measurement','Only certified (EPA 608) technicians may connect gauges to refrigerant circuits.',
 '[{"key":"low","label":"Low"},{"key":"normal","label":"Normal"},{"key":"high","label":"High"}]'),
('ac_head_pressure','Head pressure','How is the head (discharge) pressure versus the manufacturer chart?','Manifold gauges',3,'measurement','Only certified (EPA 608) technicians may connect gauges to refrigerant circuits.',
 '[{"key":"low","label":"Low"},{"key":"normal","label":"Normal"},{"key":"high","label":"High"}]'),
('ac_superheat','Superheat','How is the superheat versus target?','Manifold gauges, pipe clamp thermometer',3,'measurement','Fixed-orifice systems: use superheat. TXV systems: superheat is regulated, prefer subcooling.',
 '[{"key":"low","label":"Low"},{"key":"normal","label":"Normal"},{"key":"high","label":"High"}]'),
('ac_subcooling','Subcooling','How is the subcooling versus target?','Manifold gauges, pipe clamp thermometer',3,'measurement',NULL,
 '[{"key":"low","label":"Low"},{"key":"normal","label":"Normal"},{"key":"high","label":"High"}]'),
('ac_condenser_coil_visual','Condenser coil','What is the condition of the outdoor condenser coil?',NULL,1,'inspection',NULL,
 '[{"key":"clean","label":"Clean, clear airflow"},{"key":"dirty_blocked","label":"Dirty, matted or blocked"}]'),
('ac_leak_evidence','Leak evidence','Do you find evidence of a refrigerant leak?','Electronic leak detector or bubble solution',4,'inspection',NULL,
 '[{"key":"none","label":"No evidence of a leak"},{"key":"oil_residue","label":"Oil residue at joints / coil / fittings"},{"key":"leak_confirmed","label":"Leak confirmed (detector or bubbles)"}]'),
('ac_compressor_amps','Compressor amp draw','What is the compressor amp draw compared with the nameplate RLA?','Clamp meter',3,'measurement','Measure only on live circuits with proper PPE.',
 '[{"key":"zero","label":"Zero amps"},{"key":"low","label":"Low"},{"key":"normal","label":"Normal"},{"key":"high","label":"High (about 110 percent of RLA or more)"}]'),
('ac_capacitor_test','Run capacitor','What does the run capacitor test show versus its rating?','Capacitance meter',3,'measurement','Power off, lock out and discharge the capacitor before testing.',
 '[{"key":"in_tolerance","label":"Within tolerance"},{"key":"weak","label":"Weak (below rating)"},{"key":"failed","label":"Failed / open / swollen"}]'),
('ac_contactor_check','Contactor','What do you find at the contactor?','Multimeter',2,'measurement','24V and line voltage present. Use correct PPE.',
 '[{"key":"no_24v","label":"No 24V at the coil"},{"key":"v24_not_closing","label":"24V present but contacts do not close"},{"key":"closes_ok","label":"Closes normally, voltage passes through"},{"key":"pitted_burnt","label":"Contacts pitted or burnt"}]'),
('ac_line_voltage','Line voltage','What is the line voltage at the outdoor unit?','Multimeter',2,'measurement','High voltage. Use correct PPE and lockout procedures.',
 '[{"key":"none","label":"None"},{"key":"low","label":"Low"},{"key":"normal","label":"Normal"}]'),
('ac_thermostat_check','Thermostat test','Is the thermostat set to COOL below room temp, powered, and does jumpering R to Y at the air handler start the system?','Jumper wire',2,'measurement',NULL,
 '[{"key":"display_blank","label":"Display blank / no power"},{"key":"settings_wrong","label":"Settings or mode wrong"},{"key":"jumper_starts_unit","label":"R-Y jumper starts the system normally"},{"key":"jumper_no_start","label":"R-Y jumper still does not start it"}]'),
('ac_float_switch','Condensate float switch','Is the condensate float / overflow switch tripped?',NULL,1,'inspection',NULL,
 '[{"key":"tripped","label":"Tripped / open"},{"key":"ok","label":"OK"}]'),
('ac_low_voltage_check','Low-voltage fuse and transformer','What do the low-voltage fuse and transformer secondary show?','Multimeter',2,'measurement',NULL,
 '[{"key":"dead","label":"Blown fuse or no 24V at secondary"},{"key":"ok","label":"Fuse good, about 24V present"}]'),
('ac_winding_check','Compressor windings','What do the compressor winding checks show (terminal-to-terminal and to ground)?','Multimeter / megohmmeter',3,'measurement','Power off and lock out first.',
 '[{"key":"ok","label":"Normal"},{"key":"open_or_grounded","label":"Open winding or grounded"}]'),
-- Furnace
('fur_safety_check','Safety check','SAFETY FIRST: do you smell gas, or does a CO detector or analyzer show carbon monoxide?','CO analyzer / gas detector',1,'inspection','If YES, stop work: ventilate, shut off gas if safe, evacuate and follow emergency procedure.',
 '[{"key":"none","label":"No gas odor, no CO"},{"key":"gas_odor","label":"Gas odor present","hazard":true},{"key":"co_alarm","label":"CO alarm or elevated CO reading","hazard":true}]'),
('fur_thermostat_call','Call for heat','With the thermostat set to HEAT above room temperature, is there a call for heat (24V between R and W) at the furnace board?','Multimeter',1,'measurement',NULL,
 '[{"key":"no_call","label":"No 24V R-W (or board is dead)"},{"key":"call_present","label":"Call for heat present"}]'),
('fur_power_check','Power','Is there 120V at the furnace switch and board, with the blower door switch closed?','Multimeter',1,'measurement','High voltage. Use correct PPE.',
 '[{"key":"no_power","label":"No power"},{"key":"power_ok","label":"Power OK"}]'),
('fur_led_code','Board diagnostic code','What does the control board LED / fault code indicate?',NULL,1,'inspection',NULL,
 '[{"key":"dead","label":"No LED (dead board)"},{"key":"no_code","label":"Normal / no fault code"},{"key":"ignition_lockout","label":"Ignition failure / lockout"},{"key":"flame_code","label":"Flame sense fault"},{"key":"pressure_switch_code","label":"Pressure switch fault"},{"key":"limit_code","label":"Limit / overtemperature fault"}]'),
('fur_inducer_state','Inducer motor','Does the inducer (draft) motor start on a call for heat?',NULL,1,'inspection',NULL,
 '[{"key":"starts","label":"Starts and runs"},{"key":"does_not_start","label":"Does not start"}]'),
('fur_igniter_glow','Igniter','Does the igniter glow orange during the ignition sequence?',NULL,2,'inspection','Never touch the igniter element.',
 '[{"key":"glows","label":"Glows"},{"key":"no_glow","label":"Does not glow"},{"key":"not_reached","label":"Sequence never reaches ignition"}]'),
('fur_burner_behavior','Burner behavior','What do the burners do after ignition is attempted?',NULL,1,'inspection',NULL,
 '[{"key":"never_light","label":"Never light"},{"key":"light_then_drop","label":"Light for a few seconds, then shut off"},{"key":"cycle_off","label":"Stay lit, then shut off before the call ends"}]'),
('fur_gas_check','Gas valve','What do you find at the gas valve during the trial for ignition?','Multimeter, manometer',3,'measurement','Gas work must follow local code; licensed technicians only.',
 '[{"key":"no_24v","label":"No 24V at the valve"},{"key":"v24_gas_missing","label":"24V present but no gas flow / valve will not open"},{"key":"ok","label":"Valve opens, supply OK"}]'),
('fur_flame_signal','Flame sensor signal','What is the flame signal in microamps while the burner is lit?','Multimeter with microamp range',3,'measurement',NULL,
 '[{"key":"low_or_zero","label":"Low or zero (below manufacturer minimum)"},{"key":"ok","label":"In range"}]'),
('fur_filter_blower','Filter and blower','What are the air filter and indoor blower like?',NULL,1,'inspection',NULL,
 '[{"key":"filter_clogged","label":"Filter clogged"},{"key":"blower_not_running","label":"Blower not running or weak"},{"key":"ok","label":"Both OK"}]'),
('fur_vent_check','Vent and condensate','Are the flue, intake and condensate trap/drain blocked or holding water?',NULL,2,'inspection',NULL,
 '[{"key":"blocked","label":"Blocked / standing water"},{"key":"clear","label":"Clear"}]'),
('fur_hx_visual','Heat exchanger inspection','Heat exchanger inspection (camera or mirror): cracks, perforation, heavy soot or flame rollout?','Inspection camera',3,'inspection','If damage is found, red-tag the furnace.',
 '[{"key":"none","label":"No signs"},{"key":"signs","label":"Cracks, perforation, soot or rollout found","hazard":true}]'),
-- Water heater
('wh_safety_check','Safety check','SAFETY FIRST: do you smell gas, see a CO alarm, or see water leaking from the tank?','CO analyzer / gas detector',1,'inspection','If YES, stop: shut off power/gas and water if safe, ventilate and follow emergency procedure.',
 '[{"key":"none","label":"None of these"},{"key":"gas_odor","label":"Gas odor","hazard":true},{"key":"co_alarm","label":"CO alarm or elevated CO","hazard":true},{"key":"tank_leaking","label":"Water leaking from the tank body","hazard":true}]'),
('wh_fuel_type','Fuel type','What type of water heater is it?',NULL,1,'question',NULL,
 '[{"key":"gas","label":"Gas"},{"key":"electric","label":"Electric"}]'),
('wh_voltage_check','Voltage at elements','Is there voltage at the upper element/thermostat terminals?','Multimeter',2,'measurement','Live electrical work. Use correct PPE.',
 '[{"key":"no_voltage","label":"No voltage"},{"key":"voltage_ok","label":"Voltage present"}]'),
('wh_element_continuity','Element continuity','What does the element resistance/continuity test show?','Multimeter',2,'measurement','Power off and verify dead before testing.',
 '[{"key":"open_or_shorted","label":"Open or shorted"},{"key":"ok","label":"Normal"}]'),
('wh_thermostat_eco_test','Thermostat / ECO test','What do the thermostat and ECO (high-limit) continuity tests show?','Multimeter',2,'measurement','Power off and verify dead before testing.',
 '[{"key":"open_or_stuck","label":"Open or not responding"},{"key":"ok","label":"Normal"}]'),
('wh_pilot_state','Pilot / burner','What do the pilot and burner do?',NULL,2,'inspection',NULL,
 '[{"key":"wont_stay_lit","label":"Pilot will not stay lit"},{"key":"lit_no_burner","label":"Pilot lit, main burner does not light"},{"key":"burner_ok","label":"Burner lights and runs normally"},{"key":"no_gas_flow","label":"No gas flow at all"}]'),
('wh_water_pattern','Hot water pattern','What is the hot water behavior?',NULL,1,'question',NULL,
 '[{"key":"no_hot_ever","label":"No hot water at all"},{"key":"runs_out_fast","label":"Hot, then runs out quickly"},{"key":"lukewarm_always","label":"Always lukewarm"}]'),
('wh_sediment_noise','Sediment','Popping or rumbling while heating, or sediment in a drain-down sample?','Hose and bucket',3,'inspection','Hot water: scald risk.',
 '[{"key":"sediment_present","label":"Yes, sediment or noise"},{"key":"clean","label":"Clean, quiet"}]'),
('wh_dip_tube_debris','Plastic fragments','Are there white plastic bits in faucet aerators or filter screens?',NULL,2,'inspection',NULL,
 '[{"key":"plastic_bits","label":"Yes"},{"key":"none","label":"No"}]'),
-- Drain
('dr_fixtures_affected','Fixtures affected','How many fixtures are slow or blocked?',NULL,1,'question',NULL,
 '[{"key":"one_fixture","label":"One fixture"},{"key":"several_same_area","label":"Several fixtures in the same area/branch"},{"key":"whole_house","label":"Whole house or the lowest fixtures"}]'),
('dr_gurgling','Gurgling','Gurgling, bubbling or air burps when other fixtures drain?',NULL,1,'question',NULL,
 '[{"key":"yes","label":"Yes"},{"key":"no","label":"No"}]'),
('dr_cleanout_check','Main cleanout','With PPE, what does the main cleanout show?',NULL,2,'inspection','Wear gloves, eye protection and a mask. Sewage is a biohazard.',
 '[{"key":"backs_up","label":"Standing water / backs up"},{"key":"clear","label":"Clear, flowing"}]'),
('dr_snake_result','Snake result','What happens when you snake the line?','Hand or drum auger',3,'inspection',NULL,
 '[{"key":"clears_at_trap","label":"Clears at the trap / fixture"},{"key":"clears_in_branch","label":"Clears in the branch line"},{"key":"obstruction_in_main","label":"Obstruction in the main line"},{"key":"roots_retrieved","label":"Roots retrieved"},{"key":"hard_stop_repeats","label":"Hard stop at the same spot repeatedly"},{"key":"no_change","label":"No change after snaking"}]'),
('dr_recurrence','Recurrence','Has this happened before?',NULL,1,'question',NULL,
 '[{"key":"first_time","label":"First time"},{"key":"recurring","label":"Recurring in the same place"}]'),
('dr_camera_inspection','Camera inspection','What does the camera inspection show?','Sewer camera',4,'inspection',NULL,
 '[{"key":"clear","label":"Clear"},{"key":"roots","label":"Roots"},{"key":"offset_or_collapse","label":"Offset, belly or collapse"},{"key":"grease_debris","label":"Grease, wipes or debris"}]')
ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, question = EXCLUDED.question, tool_needed = EXCLUDED.tool_needed,
  effort = EXCLUDED.effort, kind = EXCLUDED.kind, safety_note = EXCLUDED.safety_note, answers = EXCLUDED.answers;

-- ---------------------------------------------------------------
-- Priors per symptom (pseudo-counts)
-- ---------------------------------------------------------------
INSERT INTO adn_seed_priors (symptom_key, cause_key, weight) VALUES
  ('ac_not_cooling','ac_low_charge',9),('ac_not_cooling','ac_dirty_evap',5),('ac_not_cooling','ac_restricted_airflow',5),
  ('ac_not_cooling','ac_dirty_condenser',5),('ac_not_cooling','ac_condenser_fan_failure',4),('ac_not_cooling','ac_weak_compressor',2),
  ('ac_not_cooling','ac_metering_restriction',2),('ac_not_cooling','ac_overcharge',2),('ac_not_cooling','ac_failed_blower',2),
  ('ac_wont_start','ac_no_line_power',6),('ac_wont_start','ac_no_control_signal',6),('ac_wont_start','ac_thermostat_fault',5),
  ('ac_wont_start','ac_failed_run_capacitor',7),('ac_wont_start','ac_failed_contactor',5),('ac_wont_start','ac_compressor_failure',2),
  ('ac_freezing','ac_restricted_airflow',9),('ac_freezing','ac_low_charge',8),('ac_freezing','ac_dirty_evap',6),
  ('ac_freezing','ac_failed_blower',4),('ac_freezing','ac_metering_restriction',2),
  ('furnace_no_heat','fur_no_power',6),('furnace_no_heat','fur_thermostat',4),('furnace_no_heat','fur_igniter',7),
  ('furnace_no_heat','fur_flame_sensor',6),('furnace_no_heat','fur_inducer',3),('furnace_no_heat','fur_pressure_switch',5),
  ('furnace_no_heat','fur_gas_supply_valve',4),('furnace_no_heat','fur_control_board',3),('furnace_no_heat','fur_limit_airflow',2),
  ('furnace_no_heat','fur_blower_failure',2),
  ('furnace_short_cycling','fur_limit_airflow',9),('furnace_short_cycling','fur_flame_sensor',8),('furnace_short_cycling','fur_pressure_switch',5),
  ('furnace_short_cycling','fur_blower_failure',4),('furnace_short_cycling','fur_thermostat',3),('furnace_short_cycling','fur_control_board',2),
  ('furnace_short_cycling','fur_igniter',2),
  ('wh_no_hot_water','wh_tripped_limit',5),('wh_no_hot_water','wh_failed_element',6),('wh_no_hot_water','wh_failed_thermostat',4),
  ('wh_no_hot_water','wh_pilot_thermocouple',7),('wh_no_hot_water','wh_gas_control',3),('wh_no_hot_water','wh_gas_supply',3),
  ('wh_no_hot_water','wh_dip_tube',3),('wh_no_hot_water','wh_sediment',5),('wh_no_hot_water','wh_mixing_valve',2),
  ('wh_not_enough_hot','wh_sediment',7),('wh_not_enough_hot','wh_failed_element',7),('wh_not_enough_hot','wh_dip_tube',6),
  ('wh_not_enough_hot','wh_failed_thermostat',3),('wh_not_enough_hot','wh_mixing_valve',4),('wh_not_enough_hot','wh_pilot_thermocouple',2),
  ('wh_not_enough_hot','wh_gas_control',2),
  ('furnace_no_heat','fur_gas_leak',1),('furnace_no_heat','fur_cracked_hx',1),('furnace_no_heat','fur_venting_co',1),
  ('furnace_short_cycling','fur_gas_leak',1),('furnace_short_cycling','fur_cracked_hx',2),('furnace_short_cycling','fur_venting_co',2),
  ('wh_no_hot_water','wh_gas_leak_co',1),('wh_no_hot_water','wh_tank_failure',1),
  ('wh_not_enough_hot','wh_gas_leak_co',1),('wh_not_enough_hot','wh_tank_failure',1),
  ('drain_slow_or_blocked','dr_trap_clog',10),('drain_slow_or_blocked','dr_branch_clog',8),('drain_slow_or_blocked','dr_main_blockage',5),
  ('drain_slow_or_blocked','dr_roots',3),('drain_slow_or_blocked','dr_vent_blocked',3),('drain_slow_or_blocked','dr_line_collapse',2),
  ('drain_slow_or_blocked','dr_wipes_grease',3)
ON CONFLICT (symptom_key, cause_key) DO UPDATE SET weight = EXCLUDED.weight;

-- ---------------------------------------------------------------
-- Likelihoods: P(answer | cause) as pseudo-counts. Rows: (test, causes[], {answer: weight})
-- ---------------------------------------------------------------
INSERT INTO adn_seed_likelihoods (test_key, cause_key, answer_key, weight)
SELECT t.test_key, c.cause_key, a.key, a.value::numeric
FROM (VALUES
  -- ===== AC =====
  ('ac_outdoor_unit_state', ARRAY['ac_low_charge','ac_dirty_condenser'], '{"all_running":19,"fan_only":1}'),
  ('ac_outdoor_unit_state', ARRAY['ac_dirty_evap','ac_restricted_airflow','ac_failed_blower','ac_metering_restriction','ac_overcharge'], '{"all_running":20}'),
  ('ac_outdoor_unit_state', ARRAY['ac_condenser_fan_failure'], '{"compressor_only":12,"dead":6,"hum_no_start":1,"all_running":1}'),
  ('ac_outdoor_unit_state', ARRAY['ac_weak_compressor'], '{"all_running":18,"hum_no_start":1,"fan_only":1}'),
  ('ac_outdoor_unit_state', ARRAY['ac_failed_run_capacitor'], '{"hum_no_start":10,"fan_only":6,"all_running":3,"dead":1}'),
  ('ac_outdoor_unit_state', ARRAY['ac_failed_contactor'], '{"dead":14,"all_running":2,"hum_no_start":1,"fan_only":1}'),
  ('ac_outdoor_unit_state', ARRAY['ac_no_line_power','ac_no_control_signal','ac_thermostat_fault'], '{"dead":20}'),
  ('ac_outdoor_unit_state', ARRAY['ac_compressor_failure'], '{"hum_no_start":13,"fan_only":6,"dead":1}'),

  ('ac_indoor_airflow', ARRAY['ac_low_charge'], '{"normal":15,"weak":4,"none":1}'),
  ('ac_indoor_airflow', ARRAY['ac_dirty_evap'], '{"weak":14,"normal":5,"none":1}'),
  ('ac_indoor_airflow', ARRAY['ac_restricted_airflow'], '{"weak":15,"none":3,"normal":2}'),
  ('ac_indoor_airflow', ARRAY['ac_failed_blower'], '{"none":11,"weak":8,"normal":1}'),
  ('ac_indoor_airflow', ARRAY['ac_dirty_condenser','ac_condenser_fan_failure','ac_overcharge'], '{"normal":18,"weak":2}'),
  ('ac_indoor_airflow', ARRAY['ac_weak_compressor'], '{"normal":19,"weak":1}'),
  ('ac_indoor_airflow', ARRAY['ac_metering_restriction'], '{"normal":17,"weak":3}'),

  ('ac_filter_coil_visual', ARRAY['ac_low_charge'], '{"clean":12,"iced":5,"dirty_filter":2,"dirty_coil":1}'),
  ('ac_filter_coil_visual', ARRAY['ac_dirty_evap'], '{"dirty_coil":14,"dirty_filter":3,"iced":3}'),
  ('ac_filter_coil_visual', ARRAY['ac_restricted_airflow'], '{"dirty_filter":15,"iced":3,"dirty_coil":2}'),
  ('ac_filter_coil_visual', ARRAY['ac_failed_blower'], '{"clean":13,"dirty_filter":3,"iced":2,"dirty_coil":2}'),
  ('ac_filter_coil_visual', ARRAY['ac_metering_restriction'], '{"clean":13,"iced":5,"dirty_filter":1,"dirty_coil":1}'),
  ('ac_filter_coil_visual', ARRAY['ac_dirty_condenser'], '{"clean":14,"dirty_filter":4,"dirty_coil":1,"iced":1}'),
  ('ac_filter_coil_visual', ARRAY['ac_condenser_fan_failure'], '{"clean":15,"dirty_filter":3,"iced":1,"dirty_coil":1}'),
  ('ac_filter_coil_visual', ARRAY['ac_weak_compressor','ac_overcharge'], '{"clean":16,"dirty_filter":3,"dirty_coil":1}'),

  ('ac_delta_t', ARRAY['ac_low_charge'], '{"low":15,"normal":4,"high":1}'),
  ('ac_delta_t', ARRAY['ac_dirty_evap'], '{"high":11,"normal":6,"low":3}'),
  ('ac_delta_t', ARRAY['ac_restricted_airflow'], '{"high":12,"normal":5,"low":3}'),
  ('ac_delta_t', ARRAY['ac_failed_blower'], '{"high":9,"normal":4,"low":7}'),
  ('ac_delta_t', ARRAY['ac_dirty_condenser'], '{"low":10,"normal":8,"high":2}'),
  ('ac_delta_t', ARRAY['ac_condenser_fan_failure'], '{"low":12,"normal":7,"high":1}'),
  ('ac_delta_t', ARRAY['ac_weak_compressor'], '{"low":16,"normal":3,"high":1}'),
  ('ac_delta_t', ARRAY['ac_metering_restriction'], '{"low":10,"normal":6,"high":4}'),
  ('ac_delta_t', ARRAY['ac_overcharge'], '{"low":9,"normal":9,"high":2}'),

  ('ac_suction_pressure', ARRAY['ac_low_charge','ac_failed_blower'], '{"low":17,"normal":2,"high":1}'),
  ('ac_suction_pressure', ARRAY['ac_dirty_evap','ac_restricted_airflow'], '{"low":15,"normal":4,"high":1}'),
  ('ac_suction_pressure', ARRAY['ac_dirty_condenser'], '{"high":10,"normal":8,"low":2}'),
  ('ac_suction_pressure', ARRAY['ac_condenser_fan_failure'], '{"high":14,"normal":5,"low":1}'),
  ('ac_suction_pressure', ARRAY['ac_weak_compressor'], '{"high":16,"normal":3,"low":1}'),
  ('ac_suction_pressure', ARRAY['ac_metering_restriction'], '{"low":17,"normal":2,"high":1}'),
  ('ac_suction_pressure', ARRAY['ac_overcharge'], '{"high":15,"normal":4,"low":1}'),

  ('ac_head_pressure', ARRAY['ac_low_charge'], '{"low":16,"normal":3,"high":1}'),
  ('ac_head_pressure', ARRAY['ac_dirty_evap','ac_restricted_airflow'], '{"low":11,"normal":8,"high":1}'),
  ('ac_head_pressure', ARRAY['ac_failed_blower'], '{"low":12,"normal":7,"high":1}'),
  ('ac_head_pressure', ARRAY['ac_dirty_condenser','ac_condenser_fan_failure','ac_overcharge'], '{"high":18,"normal":2}'),
  ('ac_head_pressure', ARRAY['ac_weak_compressor'], '{"low":17,"normal":3}'),
  ('ac_head_pressure', ARRAY['ac_metering_restriction'], '{"low":11,"normal":7,"high":2}'),

  ('ac_superheat', ARRAY['ac_low_charge','ac_metering_restriction'], '{"high":17,"normal":2,"low":1}'),
  ('ac_superheat', ARRAY['ac_dirty_evap','ac_restricted_airflow'], '{"low":12,"normal":7,"high":1}'),
  ('ac_superheat', ARRAY['ac_failed_blower'], '{"low":13,"normal":6,"high":1}'),
  ('ac_superheat', ARRAY['ac_dirty_condenser'], '{"normal":12,"high":5,"low":3}'),
  ('ac_superheat', ARRAY['ac_condenser_fan_failure'], '{"normal":11,"low":4,"high":5}'),
  ('ac_superheat', ARRAY['ac_weak_compressor'], '{"normal":8,"high":6,"low":6}'),
  ('ac_superheat', ARRAY['ac_overcharge'], '{"low":15,"normal":4,"high":1}'),

  ('ac_subcooling', ARRAY['ac_low_charge'], '{"low":17,"normal":2,"high":1}'),
  ('ac_subcooling', ARRAY['ac_dirty_evap','ac_restricted_airflow','ac_failed_blower'], '{"normal":11,"low":5,"high":4}'),
  ('ac_subcooling', ARRAY['ac_dirty_condenser','ac_condenser_fan_failure'], '{"normal":9,"high":6,"low":5}'),
  ('ac_subcooling', ARRAY['ac_weak_compressor'], '{"normal":9,"low":7,"high":4}'),
  ('ac_subcooling', ARRAY['ac_metering_restriction'], '{"high":15,"normal":4,"low":1}'),
  ('ac_subcooling', ARRAY['ac_overcharge'], '{"high":17,"normal":2,"low":1}'),

  ('ac_condenser_coil_visual', ARRAY['ac_dirty_condenser'], '{"dirty_blocked":18,"clean":2}'),
  ('ac_condenser_coil_visual', ARRAY['ac_condenser_fan_failure'], '{"clean":12,"dirty_blocked":8}'),
  ('ac_condenser_coil_visual', ARRAY['ac_low_charge','ac_dirty_evap','ac_restricted_airflow','ac_failed_blower','ac_weak_compressor','ac_metering_restriction','ac_overcharge'], '{"clean":14,"dirty_blocked":6}'),

  ('ac_leak_evidence', ARRAY['ac_low_charge'], '{"leak_confirmed":11,"oil_residue":6,"none":3}'),
  ('ac_leak_evidence', ARRAY['ac_dirty_evap','ac_restricted_airflow','ac_failed_blower','ac_dirty_condenser','ac_condenser_fan_failure','ac_weak_compressor','ac_metering_restriction','ac_overcharge'], '{"none":17,"oil_residue":2,"leak_confirmed":1}'),

  ('ac_compressor_amps', ARRAY['ac_low_charge'], '{"low":12,"normal":7,"zero":1}'),
  ('ac_compressor_amps', ARRAY['ac_dirty_evap','ac_restricted_airflow','ac_failed_blower'], '{"low":9,"normal":11}'),
  ('ac_compressor_amps', ARRAY['ac_dirty_condenser'], '{"high":12,"normal":8}'),
  ('ac_compressor_amps', ARRAY['ac_condenser_fan_failure'], '{"high":14,"normal":4,"zero":2}'),
  ('ac_compressor_amps', ARRAY['ac_weak_compressor'], '{"low":13,"normal":5,"high":2}'),
  ('ac_compressor_amps', ARRAY['ac_metering_restriction'], '{"low":13,"normal":7}'),
  ('ac_compressor_amps', ARRAY['ac_overcharge'], '{"high":13,"normal":7}'),
  ('ac_compressor_amps', ARRAY['ac_failed_run_capacitor'], '{"high":8,"zero":6,"low":4,"normal":2}'),
  ('ac_compressor_amps', ARRAY['ac_compressor_failure'], '{"high":15,"zero":5}'),
  ('ac_compressor_amps', ARRAY['ac_failed_contactor'], '{"zero":16,"normal":3,"low":1}'),
  ('ac_compressor_amps', ARRAY['ac_no_line_power','ac_no_control_signal','ac_thermostat_fault'], '{"zero":20}'),

  ('ac_capacitor_test', ARRAY['ac_failed_run_capacitor'], '{"failed":11,"weak":8,"in_tolerance":1}'),
  ('ac_capacitor_test', ARRAY['ac_condenser_fan_failure'], '{"in_tolerance":12,"weak":5,"failed":3}'),
  ('ac_capacitor_test', ARRAY['ac_no_line_power','ac_no_control_signal','ac_thermostat_fault','ac_failed_contactor','ac_compressor_failure'], '{"in_tolerance":17,"weak":2,"failed":1}'),
  ('ac_capacitor_test', ARRAY['ac_low_charge','ac_dirty_evap','ac_restricted_airflow','ac_failed_blower','ac_dirty_condenser','ac_weak_compressor','ac_metering_restriction','ac_overcharge'], '{"in_tolerance":16,"weak":3,"failed":1}'),

  ('ac_contactor_check', ARRAY['ac_failed_contactor'], '{"v24_not_closing":9,"pitted_burnt":9,"closes_ok":1,"no_24v":1}'),
  ('ac_contactor_check', ARRAY['ac_no_control_signal'], '{"no_24v":18,"closes_ok":2}'),
  ('ac_contactor_check', ARRAY['ac_thermostat_fault'], '{"no_24v":17,"closes_ok":3}'),
  ('ac_contactor_check', ARRAY['ac_no_line_power'], '{"closes_ok":14,"no_24v":4,"v24_not_closing":1,"pitted_burnt":1}'),
  ('ac_contactor_check', ARRAY['ac_failed_run_capacitor','ac_compressor_failure'], '{"closes_ok":17,"pitted_burnt":3}'),
  ('ac_contactor_check', ARRAY['ac_condenser_fan_failure'], '{"closes_ok":18,"pitted_burnt":2}'),

  ('ac_line_voltage', ARRAY['ac_no_line_power'], '{"none":19,"low":1}'),
  ('ac_line_voltage', ARRAY['ac_failed_run_capacitor','ac_failed_contactor','ac_no_control_signal','ac_thermostat_fault'], '{"normal":18,"low":2}'),
  ('ac_line_voltage', ARRAY['ac_compressor_failure'], '{"normal":14,"low":6}'),
  ('ac_line_voltage', ARRAY['ac_condenser_fan_failure'], '{"normal":17,"low":3}'),

  ('ac_thermostat_check', ARRAY['ac_thermostat_fault'], '{"settings_wrong":7,"jumper_starts_unit":10,"display_blank":3}'),
  ('ac_thermostat_check', ARRAY['ac_no_control_signal'], '{"display_blank":9,"jumper_no_start":10,"settings_wrong":1}'),
  ('ac_thermostat_check', ARRAY['ac_no_line_power','ac_failed_run_capacitor','ac_failed_contactor','ac_compressor_failure'], '{"jumper_no_start":18,"jumper_starts_unit":1,"settings_wrong":1}'),

  ('ac_float_switch', ARRAY['ac_no_control_signal'], '{"tripped":12,"ok":8}'),
  ('ac_float_switch', ARRAY['ac_thermostat_fault','ac_no_line_power','ac_failed_run_capacitor','ac_failed_contactor','ac_compressor_failure'], '{"tripped":1,"ok":19}'),

  ('ac_low_voltage_check', ARRAY['ac_no_control_signal'], '{"dead":15,"ok":5}'),
  ('ac_low_voltage_check', ARRAY['ac_thermostat_fault'], '{"ok":18,"dead":2}'),
  ('ac_low_voltage_check', ARRAY['ac_no_line_power','ac_failed_run_capacitor','ac_failed_contactor','ac_compressor_failure'], '{"ok":19,"dead":1}'),

  ('ac_winding_check', ARRAY['ac_compressor_failure'], '{"open_or_grounded":14,"ok":6}'),
  ('ac_winding_check', ARRAY['ac_weak_compressor'], '{"ok":17,"open_or_grounded":3}'),
  ('ac_winding_check', ARRAY['ac_failed_run_capacitor','ac_no_line_power','ac_failed_contactor','ac_no_control_signal','ac_thermostat_fault','ac_condenser_fan_failure'], '{"ok":18,"open_or_grounded":2}'),

  -- ===== Furnace =====
  ('fur_safety_check', ARRAY['fur_no_power','fur_thermostat','fur_igniter','fur_flame_sensor','fur_inducer','fur_pressure_switch','fur_control_board','fur_limit_airflow','fur_blower_failure'], '{"none":19,"gas_odor":1}'),
  ('fur_safety_check', ARRAY['fur_gas_supply_valve'], '{"none":18,"gas_odor":2}'),
  ('fur_safety_check', ARRAY['fur_gas_leak'], '{"gas_odor":19,"none":1}'),
  ('fur_safety_check', ARRAY['fur_cracked_hx'], '{"co_alarm":12,"none":8}'),
  ('fur_safety_check', ARRAY['fur_venting_co'], '{"co_alarm":14,"none":6}'),

  ('fur_thermostat_call', ARRAY['fur_thermostat'], '{"no_call":17,"call_present":3}'),
  ('fur_thermostat_call', ARRAY['fur_no_power'], '{"no_call":15,"call_present":1}'),
  ('fur_thermostat_call', ARRAY['fur_igniter','fur_flame_sensor','fur_inducer','fur_pressure_switch','fur_gas_supply_valve','fur_control_board','fur_limit_airflow','fur_blower_failure'], '{"call_present":18,"no_call":2}'),

  ('fur_power_check', ARRAY['fur_no_power'], '{"no_power":18,"power_ok":2}'),
  ('fur_power_check', ARRAY['fur_control_board'], '{"power_ok":15,"no_power":1}'),
  ('fur_power_check', ARRAY['fur_thermostat','fur_igniter','fur_flame_sensor','fur_inducer','fur_pressure_switch','fur_gas_supply_valve','fur_limit_airflow','fur_blower_failure'], '{"power_ok":19,"no_power":1}'),

  ('fur_led_code', ARRAY['fur_no_power'], '{"dead":18,"no_code":2}'),
  ('fur_led_code', ARRAY['fur_thermostat'], '{"no_code":16,"dead":2}'),
  ('fur_led_code', ARRAY['fur_igniter'], '{"ignition_lockout":15,"no_code":3,"flame_code":1,"dead":1}'),
  ('fur_led_code', ARRAY['fur_flame_sensor'], '{"flame_code":11,"ignition_lockout":6,"no_code":3}'),
  ('fur_led_code', ARRAY['fur_inducer'], '{"pressure_switch_code":12,"no_code":6}'),
  ('fur_led_code', ARRAY['fur_pressure_switch'], '{"pressure_switch_code":17,"no_code":3}'),
  ('fur_led_code', ARRAY['fur_gas_supply_valve'], '{"ignition_lockout":14,"flame_code":3,"no_code":3}'),
  ('fur_led_code', ARRAY['fur_control_board'], '{"no_code":10,"dead":6,"ignition_lockout":4}'),
  ('fur_led_code', ARRAY['fur_limit_airflow'], '{"limit_code":15,"no_code":5}'),
  ('fur_led_code', ARRAY['fur_blower_failure'], '{"limit_code":11,"no_code":8,"dead":1}'),
  ('fur_led_code', ARRAY['fur_gas_leak','fur_cracked_hx','fur_venting_co'], '{"no_code":15,"limit_code":2,"flame_code":1,"ignition_lockout":2}'),

  ('fur_inducer_state', ARRAY['fur_inducer'], '{"does_not_start":17,"starts":3}'),
  ('fur_inducer_state', ARRAY['fur_no_power'], '{"does_not_start":14,"starts":2}'),
  ('fur_inducer_state', ARRAY['fur_thermostat'], '{"does_not_start":15,"starts":1}'),
  ('fur_inducer_state', ARRAY['fur_control_board'], '{"does_not_start":10,"starts":8}'),
  ('fur_inducer_state', ARRAY['fur_igniter','fur_flame_sensor','fur_pressure_switch','fur_gas_supply_valve','fur_limit_airflow','fur_blower_failure'], '{"starts":18,"does_not_start":2}'),

  ('fur_igniter_glow', ARRAY['fur_igniter'], '{"no_glow":16,"glows":2,"not_reached":2}'),
  ('fur_igniter_glow', ARRAY['fur_flame_sensor','fur_gas_supply_valve'], '{"glows":18,"no_glow":1,"not_reached":1}'),
  ('fur_igniter_glow', ARRAY['fur_pressure_switch'], '{"not_reached":15,"glows":3,"no_glow":2}'),
  ('fur_igniter_glow', ARRAY['fur_inducer'], '{"not_reached":16,"glows":2,"no_glow":2}'),
  ('fur_igniter_glow', ARRAY['fur_no_power','fur_thermostat'], '{"not_reached":17,"no_glow":2,"glows":1}'),
  ('fur_igniter_glow', ARRAY['fur_control_board'], '{"not_reached":8,"no_glow":8,"glows":4}'),
  ('fur_igniter_glow', ARRAY['fur_limit_airflow'], '{"glows":12,"not_reached":8}'),
  ('fur_igniter_glow', ARRAY['fur_blower_failure'], '{"glows":15,"not_reached":5}'),

  ('fur_burner_behavior', ARRAY['fur_igniter'], '{"never_light":18,"light_then_drop":1,"cycle_off":1}'),
  ('fur_burner_behavior', ARRAY['fur_flame_sensor'], '{"light_then_drop":17,"never_light":2,"cycle_off":1}'),
  ('fur_burner_behavior', ARRAY['fur_gas_supply_valve'], '{"never_light":15,"light_then_drop":4,"cycle_off":1}'),
  ('fur_burner_behavior', ARRAY['fur_pressure_switch'], '{"never_light":12,"cycle_off":5,"light_then_drop":3}'),
  ('fur_burner_behavior', ARRAY['fur_inducer'], '{"never_light":17,"cycle_off":2,"light_then_drop":1}'),
  ('fur_burner_behavior', ARRAY['fur_no_power','fur_thermostat'], '{"never_light":19,"cycle_off":1}'),
  ('fur_burner_behavior', ARRAY['fur_control_board'], '{"never_light":13,"light_then_drop":4,"cycle_off":3}'),
  ('fur_burner_behavior', ARRAY['fur_limit_airflow'], '{"cycle_off":17,"never_light":2,"light_then_drop":1}'),
  ('fur_burner_behavior', ARRAY['fur_blower_failure'], '{"cycle_off":16,"never_light":3,"light_then_drop":1}'),

  ('fur_gas_check', ARRAY['fur_gas_supply_valve'], '{"v24_gas_missing":15,"no_24v":3,"ok":2}'),
  ('fur_gas_check', ARRAY['fur_igniter'], '{"no_24v":14,"ok":4,"v24_gas_missing":2}'),
  ('fur_gas_check', ARRAY['fur_flame_sensor'], '{"ok":17,"no_24v":2,"v24_gas_missing":1}'),
  ('fur_gas_check', ARRAY['fur_pressure_switch','fur_inducer','fur_no_power','fur_thermostat'], '{"no_24v":17,"ok":2,"v24_gas_missing":1}'),
  ('fur_gas_check', ARRAY['fur_control_board'], '{"no_24v":12,"ok":6,"v24_gas_missing":2}'),
  ('fur_gas_check', ARRAY['fur_limit_airflow','fur_blower_failure'], '{"ok":14,"no_24v":5,"v24_gas_missing":1}'),

  ('fur_flame_signal', ARRAY['fur_flame_sensor'], '{"low_or_zero":17,"ok":3}'),
  ('fur_flame_signal', ARRAY['fur_control_board'], '{"ok":12,"low_or_zero":8}'),
  ('fur_flame_signal', ARRAY['fur_igniter','fur_gas_supply_valve','fur_pressure_switch','fur_inducer','fur_limit_airflow','fur_blower_failure','fur_thermostat','fur_no_power'], '{"ok":16,"low_or_zero":4}'),

  ('fur_filter_blower', ARRAY['fur_limit_airflow'], '{"filter_clogged":15,"ok":3,"blower_not_running":2}'),
  ('fur_filter_blower', ARRAY['fur_blower_failure'], '{"blower_not_running":15,"ok":4,"filter_clogged":1}'),
  ('fur_filter_blower', ARRAY['fur_no_power'], '{"ok":16,"filter_clogged":3,"blower_not_running":1}'),
  ('fur_filter_blower', ARRAY['fur_thermostat','fur_igniter','fur_flame_sensor','fur_inducer','fur_pressure_switch','fur_gas_supply_valve','fur_control_board'], '{"ok":17,"filter_clogged":3}'),

  ('fur_vent_check', ARRAY['fur_pressure_switch'], '{"blocked":14,"clear":6}'),
  ('fur_vent_check', ARRAY['fur_inducer'], '{"clear":15,"blocked":5}'),
  ('fur_vent_check', ARRAY['fur_venting_co'], '{"blocked":17,"clear":3}'),
  ('fur_vent_check', ARRAY['fur_cracked_hx'], '{"clear":14,"blocked":6}'),
  ('fur_vent_check', ARRAY['fur_no_power','fur_thermostat','fur_igniter','fur_flame_sensor','fur_gas_supply_valve','fur_control_board','fur_limit_airflow','fur_blower_failure'], '{"clear":17,"blocked":3}'),

  ('fur_hx_visual', ARRAY['fur_cracked_hx'], '{"signs":16,"none":4}'),
  ('fur_hx_visual', ARRAY['fur_venting_co'], '{"none":14,"signs":6}'),
  ('fur_hx_visual', ARRAY['fur_no_power','fur_thermostat','fur_igniter','fur_flame_sensor','fur_inducer','fur_pressure_switch','fur_gas_supply_valve','fur_control_board','fur_limit_airflow','fur_blower_failure'], '{"none":19,"signs":1}'),

  -- ===== Water heater =====
  ('wh_safety_check', ARRAY['wh_tripped_limit','wh_failed_element','wh_failed_thermostat','wh_pilot_thermocouple','wh_gas_control','wh_gas_supply','wh_dip_tube','wh_sediment','wh_mixing_valve'], '{"none":19,"tank_leaking":1}'),
  ('wh_safety_check', ARRAY['wh_gas_leak_co'], '{"gas_odor":10,"co_alarm":9,"none":1}'),
  ('wh_safety_check', ARRAY['wh_tank_failure'], '{"tank_leaking":19,"none":1}'),

  ('wh_fuel_type', ARRAY['wh_tripped_limit','wh_failed_element','wh_failed_thermostat'], '{"electric":20}'),
  ('wh_fuel_type', ARRAY['wh_pilot_thermocouple','wh_gas_control','wh_gas_supply','wh_gas_leak_co'], '{"gas":20}'),
  ('wh_fuel_type', ARRAY['wh_dip_tube','wh_sediment','wh_mixing_valve','wh_tank_failure'], '{"gas":10,"electric":10}'),

  ('wh_voltage_check', ARRAY['wh_tripped_limit'], '{"no_voltage":17,"voltage_ok":3}'),
  ('wh_voltage_check', ARRAY['wh_failed_thermostat'], '{"voltage_ok":12,"no_voltage":8}'),
  ('wh_voltage_check', ARRAY['wh_failed_element','wh_dip_tube','wh_sediment','wh_mixing_valve'], '{"voltage_ok":18,"no_voltage":2}'),

  ('wh_element_continuity', ARRAY['wh_failed_element'], '{"open_or_shorted":17,"ok":3}'),
  ('wh_element_continuity', ARRAY['wh_tripped_limit','wh_failed_thermostat','wh_dip_tube','wh_sediment','wh_mixing_valve'], '{"ok":17,"open_or_shorted":3}'),

  ('wh_thermostat_eco_test', ARRAY['wh_failed_thermostat'], '{"open_or_stuck":16,"ok":4}'),
  ('wh_thermostat_eco_test', ARRAY['wh_tripped_limit'], '{"open_or_stuck":12,"ok":8}'),
  ('wh_thermostat_eco_test', ARRAY['wh_failed_element','wh_dip_tube','wh_sediment','wh_mixing_valve'], '{"ok":18,"open_or_stuck":2}'),

  ('wh_pilot_state', ARRAY['wh_pilot_thermocouple'], '{"wont_stay_lit":16,"lit_no_burner":3,"burner_ok":1}'),
  ('wh_pilot_state', ARRAY['wh_gas_control'], '{"lit_no_burner":14,"burner_ok":4,"wont_stay_lit":2}'),
  ('wh_pilot_state', ARRAY['wh_gas_supply'], '{"no_gas_flow":16,"burner_ok":2,"wont_stay_lit":2}'),
  ('wh_pilot_state', ARRAY['wh_dip_tube','wh_sediment','wh_mixing_valve'], '{"burner_ok":18,"wont_stay_lit":1,"lit_no_burner":1}'),

  ('wh_water_pattern', ARRAY['wh_tripped_limit','wh_pilot_thermocouple','wh_gas_supply'], '{"no_hot_ever":17,"lukewarm_always":2,"runs_out_fast":1}'),
  ('wh_water_pattern', ARRAY['wh_failed_element'], '{"runs_out_fast":11,"no_hot_ever":5,"lukewarm_always":4}'),
  ('wh_water_pattern', ARRAY['wh_failed_thermostat'], '{"no_hot_ever":9,"lukewarm_always":7,"runs_out_fast":4}'),
  ('wh_water_pattern', ARRAY['wh_gas_control'], '{"no_hot_ever":13,"lukewarm_always":5,"runs_out_fast":2}'),
  ('wh_water_pattern', ARRAY['wh_dip_tube'], '{"lukewarm_always":10,"runs_out_fast":9,"no_hot_ever":1}'),
  ('wh_water_pattern', ARRAY['wh_sediment'], '{"runs_out_fast":14,"lukewarm_always":5,"no_hot_ever":1}'),
  ('wh_water_pattern', ARRAY['wh_mixing_valve'], '{"lukewarm_always":15,"runs_out_fast":3,"no_hot_ever":2}'),

  ('wh_sediment_noise', ARRAY['wh_sediment'], '{"sediment_present":17,"clean":3}'),
  ('wh_sediment_noise', ARRAY['wh_dip_tube'], '{"clean":14,"sediment_present":6}'),
  ('wh_sediment_noise', ARRAY['wh_tripped_limit','wh_failed_element','wh_failed_thermostat','wh_pilot_thermocouple','wh_gas_control','wh_gas_supply','wh_mixing_valve'], '{"clean":15,"sediment_present":5}'),

  ('wh_dip_tube_debris', ARRAY['wh_dip_tube'], '{"plastic_bits":14,"none":6}'),
  ('wh_dip_tube_debris', ARRAY['wh_tripped_limit','wh_failed_element','wh_failed_thermostat','wh_pilot_thermocouple','wh_gas_control','wh_gas_supply','wh_sediment','wh_mixing_valve'], '{"none":19,"plastic_bits":1}'),

  -- ===== Drains =====
  ('dr_fixtures_affected', ARRAY['dr_trap_clog'], '{"one_fixture":17,"several_same_area":2,"whole_house":1}'),
  ('dr_fixtures_affected', ARRAY['dr_branch_clog'], '{"several_same_area":14,"one_fixture":5,"whole_house":1}'),
  ('dr_fixtures_affected', ARRAY['dr_main_blockage'], '{"whole_house":17,"several_same_area":3}'),
  ('dr_fixtures_affected', ARRAY['dr_roots'], '{"whole_house":12,"several_same_area":6,"one_fixture":2}'),
  ('dr_fixtures_affected', ARRAY['dr_vent_blocked'], '{"several_same_area":9,"whole_house":6,"one_fixture":5}'),
  ('dr_fixtures_affected', ARRAY['dr_line_collapse'], '{"whole_house":11,"several_same_area":7,"one_fixture":2}'),
  ('dr_fixtures_affected', ARRAY['dr_wipes_grease'], '{"several_same_area":9,"whole_house":8,"one_fixture":3}'),

  ('dr_gurgling', ARRAY['dr_trap_clog'], '{"no":17,"yes":3}'),
  ('dr_gurgling', ARRAY['dr_branch_clog'], '{"yes":9,"no":11}'),
  ('dr_gurgling', ARRAY['dr_main_blockage'], '{"yes":14,"no":6}'),
  ('dr_gurgling', ARRAY['dr_roots'], '{"yes":11,"no":9}'),
  ('dr_gurgling', ARRAY['dr_vent_blocked'], '{"yes":17,"no":3}'),
  ('dr_gurgling', ARRAY['dr_line_collapse'], '{"yes":10,"no":10}'),
  ('dr_gurgling', ARRAY['dr_wipes_grease'], '{"yes":9,"no":11}'),

  ('dr_cleanout_check', ARRAY['dr_trap_clog'], '{"clear":18,"backs_up":2}'),
  ('dr_cleanout_check', ARRAY['dr_branch_clog'], '{"clear":16,"backs_up":4}'),
  ('dr_cleanout_check', ARRAY['dr_main_blockage'], '{"backs_up":18,"clear":2}'),
  ('dr_cleanout_check', ARRAY['dr_roots'], '{"backs_up":15,"clear":5}'),
  ('dr_cleanout_check', ARRAY['dr_vent_blocked'], '{"clear":17,"backs_up":3}'),
  ('dr_cleanout_check', ARRAY['dr_line_collapse'], '{"backs_up":12,"clear":8}'),
  ('dr_cleanout_check', ARRAY['dr_wipes_grease'], '{"backs_up":11,"clear":9}'),

  ('dr_snake_result', ARRAY['dr_trap_clog'], '{"clears_at_trap":17,"clears_in_branch":3}'),
  ('dr_snake_result', ARRAY['dr_branch_clog'], '{"clears_in_branch":15,"clears_at_trap":3,"hard_stop_repeats":2}'),
  ('dr_snake_result', ARRAY['dr_main_blockage'], '{"obstruction_in_main":15,"hard_stop_repeats":3,"clears_in_branch":2}'),
  ('dr_snake_result', ARRAY['dr_roots'], '{"roots_retrieved":15,"hard_stop_repeats":3,"obstruction_in_main":2}'),
  ('dr_snake_result', ARRAY['dr_vent_blocked'], '{"no_change":15,"clears_at_trap":3,"clears_in_branch":2}'),
  ('dr_snake_result', ARRAY['dr_line_collapse'], '{"hard_stop_repeats":16,"obstruction_in_main":3,"roots_retrieved":1}'),
  ('dr_snake_result', ARRAY['dr_wipes_grease'], '{"obstruction_in_main":8,"clears_in_branch":8,"hard_stop_repeats":3,"no_change":1}'),

  ('dr_recurrence', ARRAY['dr_trap_clog'], '{"first_time":14,"recurring":6}'),
  ('dr_recurrence', ARRAY['dr_branch_clog'], '{"recurring":11,"first_time":9}'),
  ('dr_recurrence', ARRAY['dr_main_blockage'], '{"recurring":9,"first_time":11}'),
  ('dr_recurrence', ARRAY['dr_roots'], '{"recurring":17,"first_time":3}'),
  ('dr_recurrence', ARRAY['dr_vent_blocked'], '{"first_time":10,"recurring":10}'),
  ('dr_recurrence', ARRAY['dr_line_collapse','dr_wipes_grease'], '{"recurring":16,"first_time":4}'),

  ('dr_camera_inspection', ARRAY['dr_trap_clog','dr_vent_blocked'], '{"clear":17,"grease_debris":2,"roots":1}'),
  ('dr_camera_inspection', ARRAY['dr_branch_clog'], '{"grease_debris":12,"clear":6,"roots":2}'),
  ('dr_camera_inspection', ARRAY['dr_main_blockage'], '{"grease_debris":9,"roots":5,"clear":4,"offset_or_collapse":2}'),
  ('dr_camera_inspection', ARRAY['dr_roots'], '{"roots":18,"clear":1,"offset_or_collapse":1}'),
  ('dr_camera_inspection', ARRAY['dr_line_collapse'], '{"offset_or_collapse":18,"clear":1,"roots":1}'),
  ('dr_camera_inspection', ARRAY['dr_wipes_grease'], '{"grease_debris":17,"clear":2,"offset_or_collapse":1}')
) AS t(test_key, causes, w)
CROSS JOIN LATERAL unnest(t.causes) AS c(cause_key)
CROSS JOIN LATERAL jsonb_each_text(t.w::jsonb) AS a(key, value)
ON CONFLICT (test_key, cause_key, answer_key) DO UPDATE SET weight = EXCLUDED.weight;

-- ---------------------------------------------------------------
-- Integrity check: every seeded answer must be a real answer of its test,
-- every test/cause family pairing must be consistent.
-- ---------------------------------------------------------------
DO $$
DECLARE v_bad integer;
BEGIN
  SELECT count(*) INTO v_bad
  FROM adn_seed_likelihoods sl
  JOIN adn_tests t ON t.key = sl.test_key
  WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(t.answers) e WHERE e->>'key' = sl.answer_key);
  IF v_bad > 0 THEN RAISE EXCEPTION 'ADN seed: % likelihood rows reference unknown answers', v_bad; END IF;

  SELECT count(*) INTO v_bad
  FROM adn_symptoms s, unnest(s.mandatory_test_keys) AS m(k)
  WHERE NOT EXISTS (SELECT 1 FROM adn_tests t WHERE t.key = m.k);
  IF v_bad > 0 THEN RAISE EXCEPTION 'ADN seed: mandatory test missing'; END IF;

  SELECT count(*) INTO v_bad
  FROM adn_seed_priors p
  JOIN adn_symptoms s ON s.key = p.symptom_key
  JOIN adn_causes c ON c.key = p.cause_key
  WHERE s.family <> c.family;
  IF v_bad > 0 THEN RAISE EXCEPTION 'ADN seed: prior links a symptom to a cause of another family'; END IF;
END $$;

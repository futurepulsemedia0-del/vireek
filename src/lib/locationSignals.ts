/**
 * Hand-written, trade-specific demand signals per climate pattern.
 * Every industry slug MUST define all seven tags (enforced by the type and by
 * locations.test.ts), so each city x trade page gets genuinely distinct copy.
 */
export type ClimateTag =
  | 'extreme-heat'
  | 'humid-heat'
  | 'hurricane'
  | 'severe-storm'
  | 'hard-freeze'
  | 'monsoon'
  | 'wet-mild';

export const CLIMATE_LABELS: Record<ClimateTag, string> = {
  'extreme-heat': 'Extreme heat',
  'humid-heat': 'Hot, humid summers',
  hurricane: 'Hurricane season',
  'severe-storm': 'Severe storms',
  'hard-freeze': 'Hard freezes',
  monsoon: 'Monsoon season',
  'wet-mild': 'Wet, mild climate',
};

type Signals = Record<ClimateTag, string>;

export const TRADE_SIGNALS: Record<string, Signals> = {
  hvac: {
    'extreme-heat': 'Sustained triple-digit heat pushes air conditioners to their limits, so no-cool calls bunch into the same few afternoon hours.',
    'humid-heat': 'Long, humid summers keep systems running almost nonstop, driving frozen-coil, clogged-drain and refrigerant-leak calls.',
    hurricane: 'Storm outages, flooding and power surges bring bursts of restart, water-damage and condenser-replacement calls.',
    'severe-storm': 'Hail and high winds damage outdoor condensers and trigger a wave of AC repair requests right after a storm.',
    'hard-freeze': 'Deep cold snaps stack no-heat calls into a single night, often when furnaces are already near the end of their life.',
    monsoon: 'Monsoon dust, lightning and power surges knock out cooling equipment during the hottest weeks of the year.',
    'wet-mild': 'Mild winters mean fewer true emergencies, but heat pump, ductless and air-quality inquiries arrive steadily all year.',
  },
  plumbing: {
    'extreme-heat': 'Heat-stressed water heaters, hard-water scaling and failing outdoor lines turn up as steady repair and replacement calls.',
    'humid-heat': 'High humidity and heavy use expose slow leaks, condensation problems and clogged drains that homeowners finally call about.',
    hurricane: 'Flooding and sewer backups follow tropical storms, along with shutoff-valve and sump-related emergency calls.',
    'severe-storm': 'Storm-driven power loss and heavy rain overload sump pumps and sewer lines, creating same-day backup calls.',
    'hard-freeze': 'Freezing temperatures burst exposed pipes, and the calls arrive in a rush the morning after the temperature drops.',
    monsoon: 'Sudden monsoon downpours stress drains and sewer laterals, and flash-flood backups show up as urgent calls.',
    'wet-mild': 'Persistent rain and older cast-iron or clay lines lead to slow drains, root intrusion and recurring sewer-line calls.',
  },
  roofing: {
    'extreme-heat': 'Intense sun and heat cycles age shingles, tile underlayment and flat roofs, so inspection and repair requests build through summer.',
    'humid-heat': 'Heat, humidity and afternoon storms promote algae, moss and leaks, driving repair and replacement estimates.',
    hurricane: 'After a named storm, call volume can jump overnight, with tarping, leak and insurance-claim requests competing for the same crews.',
    'severe-storm': 'Hail and wind events produce sudden spikes in inspection and insurance-claim calls from whole neighborhoods at once.',
    'hard-freeze': 'Ice dams, snow load and freeze-thaw cycles create leak calls that are both urgent and weather-dependent.',
    monsoon: 'Monsoon wind and heavy rain expose weak flashing and tile damage, creating leak calls in short, intense windows.',
    'wet-mild': 'Constant rain and moss growth make leak diagnosis and gutter-related calls a year-round workload.',
  },
  electrical: {
    'extreme-heat': 'Heavy air-conditioning load strains panels and circuits, and breaker trips or burning smells prompt urgent safety calls.',
    'humid-heat': 'Humidity and summer storms contribute to tripped breakers, failed outdoor outlets and surge-related damage calls.',
    hurricane: 'Outages, flooded equipment and generator or transfer-switch needs generate urgent calls before and after storms.',
    'severe-storm': 'Lightning, downed lines and storm surges lead to dead outlets, damaged panels and no-power emergencies.',
    'hard-freeze': 'Cold snaps push heating loads onto older panels and space heaters, increasing breaker, outlet and safety calls.',
    monsoon: 'Monsoon lightning and utility surges damage appliances and panels, creating sudden bursts of no-power calls.',
    'wet-mild': 'Damp conditions affect outdoor wiring and older service panels, while EV-charger and panel-upgrade requests stay steady.',
  },
  restoration: {
    'extreme-heat': 'Failed AC condensate lines, supply-line breaks and summer fires drive water and fire damage calls even in dry climates.',
    'humid-heat': 'Humidity speeds mold growth after any water event, so callers want mitigation started within hours, not days.',
    hurricane: 'Flood and wind damage arrive in volume, and the first company to answer the phone usually wins the job.',
    'severe-storm': 'Hail breaches, wind-driven rain and fallen trees create water-intrusion calls that are time-critical.',
    'hard-freeze': 'Burst pipes during freezes cause some of the most severe water losses, often discovered after hours.',
    monsoon: 'Flash flooding and roof leaks from monsoon storms trigger urgent water-extraction requests.',
    'wet-mild': 'Persistent moisture leads to hidden leaks, mold and rot, so inspection and mitigation calls come in year-round.',
  },
  locksmith: {
    'extreme-heat': 'Summer heat makes lockouts more dangerous, especially locked-in-car calls where waiting is not an option.',
    'humid-heat': 'Heat and humidity swell doors, wear locks and strain car key fobs, adding to lockout and rekey calls.',
    hurricane: 'Storm damage leads to broken doors, board-ups and emergency lock replacement on short notice.',
    'severe-storm': 'Storm damage to doors and frames creates urgent securing, rekey and lock-replacement calls.',
    'hard-freeze': 'Frozen locks and car doors, plus winter lockouts in subzero air, make speed the whole job.',
    monsoon: 'Monsoon season brings door damage and evening lockouts when callers are stuck outside in bad weather.',
    'wet-mild': 'Rain makes every lockout feel urgent, and damp conditions seize older locks and deadbolts.',
  },
  'pest-control': {
    'extreme-heat': 'Extreme heat drives scorpions, roaches and rodents toward cooler indoor spaces, producing steady urgent service requests.',
    'humid-heat': 'Warm, humid conditions support year-round ants, roaches, termites and mosquitoes, so there is no real off-season.',
    hurricane: 'Flooded ground and displaced pests bring rodent, ant and mosquito calls in the weeks after a storm.',
    'severe-storm': 'Heavy rain pushes ants, roaches and rodents indoors, and swarmer season generates concentrated termite calls.',
    'hard-freeze': 'Cold weather sends rodents indoors, and homeowners call about droppings and noises in walls and attics.',
    monsoon: 'Monsoon humidity and rain trigger scorpion, cricket and roach activity after long, dry stretches.',
    'wet-mild': 'Mild, damp weather keeps ants, spiders, rodents and moisture-loving pests active through winter.',
  },
  'lawn-care': {
    'extreme-heat': 'Heat and water restrictions make irrigation repair, drought-tolerant landscaping and seasonal scheduling common requests.',
    'humid-heat': 'A long growing season and humid weather push weed, fungus and mowing-frequency questions through most of the year.',
    hurricane: 'Debris cleanup, tree trimming and landscape recovery requests flood in once a storm clears.',
    'severe-storm': 'Storm debris, hail-damaged turf and fallen limbs generate bursts of cleanup and tree-service requests.',
    'hard-freeze': 'Short growing seasons compress spring startup, aeration and fall cleanup into narrow windows that jam the phones.',
    monsoon: 'Monsoon runoff creates drainage, erosion and irrigation-repair requests across desert landscapes.',
    'wet-mild': 'Year-round growth and frequent rain drive moss control, drainage fixes and standing mowing schedules.',
  },
  cleaning: {
    'extreme-heat': 'Dust, heat and heavy indoor living drive recurring-service sign-ups, and short-term rental turnovers need fast confirmation.',
    'humid-heat': 'Humidity and pollen make recurring deep-cleaning and allergy-focused service a common request.',
    hurricane: 'Post-storm cleanup and move-out cleans create last-minute demand when residents return or relocate.',
    'severe-storm': 'Storm debris, wet floors and mud lead to one-time deep-clean requests that must be scheduled quickly.',
    'hard-freeze': 'Long indoor winters mean spring deep-cleans and holiday-prep bookings arrive in concentrated waves.',
    monsoon: 'Monsoon dust and mud tracked indoors drive booking requests for deep cleans and recurring visits.',
    'wet-mild': 'Wet weather keeps people indoors and tracks dirt through homes, supporting steady recurring-clean bookings.',
  },
  'pool-service': {
    'extreme-heat': 'Heat and evaporation make year-round pool care essential, and green-pool and pump-failure calls spike in summer.',
    'humid-heat': 'Warm water and humidity fuel algae blooms and chemistry swings that turn into urgent green-pool calls.',
    hurricane: 'Storm debris and flooding contaminate pools, creating cleanup, pump and equipment-check calls after landfall.',
    'severe-storm': 'Storm debris and heavy rain unbalance water chemistry and clog filters, producing quick-turnaround cleanup calls.',
    'hard-freeze': 'Pool openings and closings are tightly timed, and freeze damage to plumbing and equipment drives urgent calls.',
    monsoon: 'Monsoon dust, wind and rain dirty pools overnight, creating cleanup and chemical-balance calls.',
    'wet-mild': 'Rain and leaf debris keep filters and chemistry changing, while heated-pool and equipment repairs stay steady.',
  },
  'appliance-repair': {
    'extreme-heat': 'Hot garages and nonstop kitchens stress refrigerators and freezers, and no-cool fridge calls are time-sensitive.',
    'humid-heat': 'Humidity and heavy use strain refrigerators, dryers and ice makers, producing steady repair calls.',
    hurricane: 'Power surges and outages damage refrigerators, washers and ranges, and food-spoilage pressure makes calls urgent.',
    'severe-storm': 'Storm outages and surges kill control boards and compressors, creating repair calls within days of an event.',
    'hard-freeze': 'Cold snaps and grid stress cause appliance failures, and dryer and heating-adjacent issues compete for same-day slots.',
    monsoon: 'Monsoon lightning and surges damage control boards and compressors, and callers want the earliest appointment.',
    'wet-mild': 'Damp climates mean heavy dryer use and long run-times, so vent and heating-element calls are steady.',
  },
  solar: {
    'extreme-heat': 'Strong sun potential and high cooling bills drive new-install inquiries, while inverter and performance-drop calls need quick triage.',
    'humid-heat': 'Strong sun and high cooling bills fuel quote requests, and monitoring-alert and production questions follow.',
    hurricane: 'Wind-rated mounting questions, storm-damage inspections and post-outage battery-backup inquiries are common.',
    'severe-storm': 'Hail and wind raise panel-damage inspections and insurance questions, alongside new-install interest.',
    'hard-freeze': 'Snow cover, cold-weather production and battery questions generate monitoring and performance calls.',
    monsoon: 'Dust, storm damage and inverter faults after monsoon events generate service and panel-cleaning calls.',
    'wet-mild': 'Cloudy seasons raise production and payback questions, so qualification matters before booking a site visit.',
  },
  painting: {
    'extreme-heat': 'Intense sun fades and cracks exterior paint, and estimate requests cluster in cooler spring and fall windows.',
    'humid-heat': 'Humidity, mildew and sun wear shorten exterior paint life, so exterior estimate requests are steady.',
    hurricane: 'Storm repair and insurance-driven repaint work generates estimate requests after hurricane season.',
    'severe-storm': 'Hail and wind damage to siding and trim leads to repaint estimates, often coordinated with insurance claims.',
    'hard-freeze': 'The exterior painting season is short, so estimate requests pile up as soon as temperatures allow.',
    monsoon: 'Monsoon moisture and intense sun make exterior timing a key question on every estimate call.',
    'wet-mild': 'Rain limits exterior windows, so scheduling and prep questions dominate estimate calls.',
  },
};

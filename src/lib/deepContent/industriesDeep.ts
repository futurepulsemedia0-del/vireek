import type { DeepContentData, DeepFaq } from './types';

interface TradeInput {
  name: string;
  audience: string;
  intro: string;
  /** [call type, urgency, what Sarah captures] */
  calls: Array<[string, string, string]>;
  urgent: string[];
  routine: string[];
  questions: string[];
  seasonal: string;
  handoff: string[];
  /** Three trade-specific setup notes: services/area, urgency rules, test scenarios. */
  setup: [string, string, string];
  limits: string[];
  faqs: DeepFaq[];
}

const RELATED = [
  { label: 'All industries', href: '/industries' },
  { label: 'Features', href: '/features' },
  { label: 'Pricing', href: '/pricing' },
  { label: 'ROI calculator', href: '/calculator' },
  { label: 'Missed calls', href: '/use-cases/missed-calls' },
  { label: 'Emergency dispatch', href: '/use-cases/emergency-dispatch' },
  { label: 'After-hours coverage', href: '/use-cases/after-hours' },
  { label: 'Integrations', href: '/integrations' },
];

function build(t: TradeInput): DeepContentData {
  return {
    eyebrow: `${t.name} call handling`,
    title: `How calls to ${t.audience} are handled, step by step`,
    intro: t.intro,
    related: RELATED,
    sections: [
      {
        id: 'calls',
        title: `The calls ${t.audience} actually receive`,
        blocks: [
          {
            kind: 'table',
            caption: `Typical ${t.name} call types`,
            headers: ['Call type', 'Urgency', 'What Sarah captures'],
            rows: t.calls.map((c) => [c[0], c[1], c[2]]),
          },
        ],
      },
      {
        id: 'urgency',
        title: 'Sorting urgent from routine',
        blocks: [
          {
            kind: 'p',
            text: `Urgency is decided by the escalation rules you set, not guessed. These are typical signals for ${t.audience}, and you can adjust them to your own policy and service area.`,
          },
          { kind: 'p', text: 'Typically treated as urgent:' },
          { kind: 'list', items: t.urgent },
          { kind: 'p', text: 'Typically routine:' },
          { kind: 'list', items: t.routine },
          {
            kind: 'callout',
            title: 'Emergency services are not replaced',
            text: 'Sarah can flag a call and route it to the people you named. She does not replace 911 or any emergency service. If a caller describes immediate danger, the right instruction is to contact local emergency services.',
          },
        ],
      },
      {
        id: 'questions',
        title: 'The questions that change the job',
        blocks: [
          {
            kind: 'p',
            text: `The value of a ${t.name} call is in the follow-up questions. These are the ones that usually decide scheduling, crew and equipment.`,
          },
          { kind: 'list', items: t.questions },
        ],
      },
      {
        id: 'seasonality',
        title: 'Peaks, weather and timing',
        blocks: [{ kind: 'p', text: t.seasonal }],
      },
      {
        id: 'handoff',
        title: 'What reaches your team',
        blocks: [
          {
            kind: 'p',
            text: 'After a call, the details are logged so nobody has to listen to a recording to understand it. A typical record includes:',
          },
          { kind: 'list', items: t.handoff },
        ],
      },
      {
        id: 'setup',
        title: `Setting it up for ${t.name}`,
        blocks: [
          {
            kind: 'steps',
            items: [
              { title: 'Describe your services and area', text: t.setup[0] },
              { title: 'Define what counts as urgent', text: t.setup[1] },
              { title: 'Test with real scenarios', text: t.setup[2] },
            ],
          },
        ],
      },
      {
        id: 'limits',
        title: `Limits worth knowing for ${t.name}`,
        blocks: [
          {
            kind: 'list',
            items: [
              ...t.limits,
              `Your escalation rules and knowledge base determine how well ${t.name} calls are handled, so read the first weeks of call summaries and correct any gaps.`,
            ],
          },
        ],
      },
    ],
    faqs: t.faqs,
  };
}

const TRADES: Record<string, TradeInput> = {
  hvac: {
    name: 'HVAC',
    audience: 'HVAC companies',
    intro:
      'HVAC calls arrive in waves driven by the weather, and most are about comfort, safety and timing rather than a specific part. The first cold snap and the first heat wave can fill the phones in an afternoon, exactly when technicians are busiest. This page explains how Sarah sorts those calls and what your team receives.',
    calls: [
      ['No heat or no cooling', 'Urgent in extreme weather', 'System type, symptoms, how long it has been out, and the property address'],
      ['Unusual noise or smell', 'Depends on the smell', 'What the noise or smell is, when it began, and whether the system is still running'],
      ['Water leaking from the unit', 'Urgent if actively leaking', 'Where the water is, and whether the system has been switched off'],
      ['Tune-up or maintenance', 'Routine', 'Equipment type and age, last service date, and any membership'],
      ['Replacement estimate', 'Routine, high value', 'Current system, home size, and what prompted the question'],
      ['Thermostat or filter question', 'Routine', 'The symptom, so your team can decide whether a visit is needed'],
    ],
    urgent: [
      'No heat during cold weather, especially where someone vulnerable is in the home.',
      'No cooling during extreme heat for the same reason.',
      'Smoke or a burning smell from equipment.',
      'A suspected gas smell, where the caller should leave the building and contact the gas utility or emergency services.',
      'A carbon monoxide alarm sounding, where the caller should get to fresh air and contact emergency services.',
    ],
    routine: [
      'Seasonal tune-ups and maintenance plans.',
      'Filter replacement and thermostat questions.',
      'Replacement estimates and financing questions for your office to answer.',
    ],
    questions: [
      'Is it a furnace, heat pump, central air or a ductless system, and roughly how old is it?',
      'Is there no heat or cooling at all, or is it weak or uneven?',
      'Is the system running, cycling on and off, or completely dead?',
      'Is the thermostat displaying anything, and have the filter and breaker been checked?',
      'Is anyone in the home particularly vulnerable to temperature, such as an infant or an older adult?',
    ],
    seasonal:
      'HVAC demand is sharply seasonal. The first sustained cold snap and the first heat wave produce a surge of no-heat and no-cool calls within hours, and a phone line staffed for a normal week cannot absorb it. Answering every call during those peaks means urgent jobs are triaged first and routine requests are booked instead of left in a voicemail queue. In milder shoulder seasons the same coverage helps you fill the schedule with tune-ups and maintenance visits that are easy to forget to chase.',
    handoff: [
      'Caller name, phone number and service address.',
      'Equipment type, symptoms and how long the problem has existed.',
      'Whether the call was classed urgent under your rules and who was alerted.',
      'Any booking made, or a note that the lead is waiting for your office.',
    ],
    setup: [
      'List the systems you service, such as furnaces, heat pumps and ductless units, and the postal codes or cities you cover.',
      'Decide which temperatures and situations make a no-heat or no-cool call an emergency, and who is on call to receive the alert.',
      'Practise a no-heat call, a maintenance request and an out-of-area call before routing live traffic.',
    ],
    limits: [
      'Sarah does not diagnose faults over the phone or promise a repair outcome.',
      'Gas and carbon monoxide situations are for emergency services first, with your team second.',
      'Pricing questions are best answered by your office unless you have given her a published price list.',
    ],
    faqs: [
      { q: 'Can she tell a real emergency from a comfort issue?', a: 'She applies the urgency rules you define, using the caller’s description of temperature, safety and who is in the home. You can tighten or loosen those rules after reviewing real calls.' },
      { q: 'What happens to maintenance-plan members?', a: 'If you record membership in your systems, her notes can flag that a caller mentions one, so your office can prioritise it. How membership is verified remains your policy.' },
      { q: 'Can she handle a flood of calls during a heat wave?', a: 'She answers calls without hold queues, so volume itself does not cause missed calls. The limit is how many technicians you can dispatch, which is why clear urgency rules matter.' },
    ],
  },
  plumbing: {
    name: 'Plumbing',
    audience: 'plumbers',
    intro:
      'Plumbing calls are often emergencies with a clock running: water is leaving a pipe, a drain is backing up or a heater has failed. Callers want a fast human-sounding answer and a clear next step, and they will call the next number if they do not get one.',
    calls: [
      ['Burst pipe or active leak', 'Urgent', 'Where the water is, whether the main can be shut off, and the address'],
      ['Sewer or drain backup', 'Urgent', 'Which fixtures are affected, and whether wastewater is entering the home'],
      ['No hot water', 'Same day if possible', 'Water heater type and age, any leaking, and whether the pilot or power is on'],
      ['Clogged drain or toilet', 'Routine to urgent', 'Which fixture, whether other drains are affected, and whether it has overflowed'],
      ['Fixture or faucet repair', 'Routine', 'The fixture and the symptom'],
      ['Water heater or repipe estimate', 'Routine, high value', 'Property type, current setup, and the reason for the question'],
    ],
    urgent: [
      'Active flooding or a burst pipe, especially where water cannot be shut off.',
      'Sewage backing up into the home.',
      'A suspected gas smell, where the caller should leave and contact the gas utility or emergency services.',
      'A water heater leaking heavily or showing signs of overheating.',
    ],
    routine: [
      'Dripping faucets and running toilets.',
      'Slow drains with no overflow.',
      'Fixture upgrades and estimates for larger projects.',
    ],
    questions: [
      'Is water actively flowing right now, and do you know where the main shut-off is?',
      'Where is the water or backup, and is it near electrical outlets or appliances?',
      'Is it one fixture or several, which helps separate a local clog from a main-line problem?',
      'Is the property a house, an apartment or a commercial space, and who owns it?',
      'How old is the water heater, and what type is it?',
    ],
    seasonal:
      'Plumbing has its own peaks. Hard freezes cause burst pipes in clusters, holiday weekends bring drain failures when guests arrive, and heavy rain exposes sewer and sump problems. These events are unpredictable, and they often happen after hours. Answering around the clock means the burst-pipe call at night reaches a person who can alert your on-call plumber, not a voicemail that the customer abandons while water spreads.',
    handoff: [
      'Name, phone number and address, with a note on access if the caller provides it.',
      'What is leaking or blocked and how the caller describes the severity.',
      'Whether the shut-off was found, so the technician arrives with the right expectations.',
      'The urgency classification and the people alerted.',
    ],
    setup: [
      'List the work you take on, such as drain clearing, water heaters and repiping, and the areas you cover.',
      'Decide whether active leaks and sewer backups trigger an immediate page to an on-call plumber, and set the contacts.',
      'Test a burst-pipe call, a routine faucet repair and a request outside your area.',
    ],
    limits: [
      'Sarah can share basic safety guidance you approve, but she does not diagnose or direct repairs.',
      'Emergency plumbing is a dispatch question first, and availability depends on your on-call staffing.',
      'Quotes for larger projects usually need an on-site visit, so she books a visit rather than giving a price.',
    ],
    faqs: [
      { q: 'Can she tell callers how to shut off water?', a: 'She can ask whether they know where the shut-off is and note the answer for your technician. Any instructions she gives are limited to what you have written into your knowledge base.' },
      { q: 'What if the caller is a landlord or a tenant?', a: 'She can capture who is calling, who owns the property and any permission needed, so your office knows who authorises the work and who pays.' },
      { q: 'Does she book same-day visits?', a: 'She books against the real availability in your connected calendar. For urgent jobs, your rules determine whether she alerts on-call staff instead of or in addition to booking.' },
    ],
  },
  roofing: {
    name: 'Roofing',
    audience: 'roofing companies',
    intro:
      'Roofing leads come in two very different shapes: a sudden leak after a storm and a considered replacement estimate. Storm events create a surge of both within days, and homeowners often call several roofers. Fast, organised intake is the difference between being on the shortlist and not.',
    calls: [
      ['Active roof leak', 'Urgent', 'Where water is entering, how much, and whether anything has been covered'],
      ['Storm or wind damage', 'Urgent to same week', 'Type of damage, date of the storm, and photos if your team requests them'],
      ['Inspection request', 'Routine', 'Roof type, age, and what prompted the inspection'],
      ['Replacement estimate', 'Routine, high value', 'Roof size or home size, material preference, and timing'],
      ['Repair of a known issue', 'Routine', 'Location of the issue and any previous repair'],
      ['Gutter or flashing issue', 'Routine', 'The symptom and the location on the property'],
    ],
    urgent: [
      'Water actively entering the home through the roof.',
      'A tree or debris on the roof, or visible structural damage.',
      'A tarp or temporary cover needed before more rain.',
    ],
    routine: [
      'Routine inspections and maintenance.',
      'Replacement estimates with no active damage.',
      'Gutter and flashing repairs.',
    ],
    questions: [
      'Is water entering the home now, and is there a safe place to stage buckets or covers?',
      'When did the damage occur, and was it tied to a specific storm?',
      'How old is the roof, what is it made of, and is it a single-storey or taller building?',
      'Is the caller planning to involve their insurer, so your team knows to expect that conversation?',
      'Is the property occupied, and who has authority to approve the work?',
    ],
    seasonal:
      'Roofing demand follows weather events. A hailstorm or high-wind event can generate a week of inbound calls, and many callers are comparing several contractors. Answering immediately and capturing the details in one conversation lets your estimators plan efficient days rather than returning missed calls late. In quieter periods, inspection and maintenance requests benefit from the same follow-up, because they often become replacement projects later.',
    handoff: [
      'Name, phone and property address.',
      'The nature of the damage, the date it occurred and any urgency.',
      'Roof type, approximate age and whether an insurer is involved.',
      'Any inspection or estimate appointment that was booked.',
    ],
    setup: [
      'List the materials and project types you handle and the areas you cover, including any storm-response territory.',
      'Define how active leaks are handled, including who arranges temporary protection and the order of callbacks.',
      'Test a storm-damage call, a replacement estimate and a request outside your region.',
    ],
    limits: [
      'Sarah does not give insurance or claims advice. She notes that an insurer may be involved and passes it to your team.',
      'She cannot assess damage remotely, so inspections and estimates are booked as visits.',
      'During large events, your crew capacity limits response time regardless of how quickly calls are answered.',
    ],
    faqs: [
      { q: 'Can she handle storm-surge volume?', a: 'She answers every call without a queue, so intake does not bottleneck. Your estimators and crews remain the limit on how fast jobs are completed.' },
      { q: 'Does she collect photos?', a: 'She can ask whether the caller has photos and note how to send them, according to the process you set. Handling of the photos is part of your workflow.' },
      { q: 'Can she tell leads from existing customers?', a: 'Repeat callers are recognised by phone number, and records are enriched, so returning customers do not create duplicates.' },
    ],
  },
  electrical: {
    name: 'Electrical',
    audience: 'electricians',
    intro:
      'Electrical calls mix genuine hazards with routine upgrades, and getting the sort wrong is costly in both directions. A caller describing sparks needs a different response from one asking about an EV charger. Clear triage, captured at the first contact, helps your team respond to the right call first.',
    calls: [
      ['Sparks, burning smell or smoke', 'Urgent', 'What was seen or smelled, where, and whether power has been switched off'],
      ['Partial or total power loss', 'Urgent to same day', 'Which areas are affected, whether neighbours are out, and what has been tried'],
      ['Breaker that keeps tripping', 'Same day to routine', 'Which breaker, what triggers it, and any new appliances'],
      ['Outlet or switch not working', 'Routine', 'The location and symptom'],
      ['Panel upgrade or EV charger', 'Routine, high value', 'Property type, existing panel details, and the goal'],
      ['Lighting or fan installation', 'Routine', 'Fixture type, number of fixtures, and ceiling or wiring concerns'],
    ],
    urgent: [
      'Sparks, smoke or a burning smell from outlets, panels or appliances.',
      'Any situation where the caller reports a shock or someone injured, where emergency services come first.',
      'A fully dead panel or a hot panel.',
    ],
    routine: [
      'Outlet, switch and lighting work.',
      'Panel upgrades, EV charger installs and renovation wiring.',
      'Inspections and safety checks.',
    ],
    questions: [
      'Is there any smell of burning, visible damage or warmth at the panel or outlet?',
      'Is the whole property affected, or only certain circuits?',
      'Is the breaker tripping repeatedly, and did the problem start after a new appliance was plugged in?',
      'What is the age and type of the home’s electrical panel, if the caller knows?',
      'Is this a repair, an upgrade or new installation, which changes the type of visit?',
    ],
    seasonal:
      'Electrical demand follows storms, heat waves and renovation seasons. Storms bring outages and surge damage, hot weather stresses older panels, and spring and summer are busy for upgrades and charger installs. A steady flow of high-value project requests also arrives through the year, which makes consistent follow-up on estimates especially valuable.',
    handoff: [
      'Name, phone and address.',
      'What was observed, where, and whether power has been shut off.',
      'The urgency classification and any on-call alert sent.',
      'For projects, the scope, property type and preferred timing.',
    ],
    setup: [
      'List residential and commercial services you provide, and note any licence or area limits your policy requires.',
      'Define precisely which symptoms trigger an immediate page and who answers it.',
      'Test a burning-smell call, a tripping-breaker call and an EV charger enquiry.',
    ],
    limits: [
      'Sarah does not give electrical repair instructions. For any hazard she directs the caller to safety and emergency services according to your wording.',
      'Permits, licensing and code questions belong with your team.',
      'Project pricing requires a site visit, so she books an estimate rather than quoting.',
    ],
    faqs: [
      { q: 'Does she tell callers to switch off the main?', a: 'Only if you have written that guidance into your knowledge base. Safety wording is the kind of thing worth reviewing carefully with your own policies.' },
      { q: 'Can she separate residential from commercial work?', a: 'Yes. She asks about property type and routes accordingly, according to the rules you set.' },
      { q: 'How are EV charger leads handled?', a: 'She captures the property, the panel details the caller knows and the timing, then books a site assessment where you offer one.' },
    ],
  },
  restoration: {
    name: 'Restoration',
    audience: 'restoration companies',
    intro:
      'Restoration callers are usually in distress. A flooded kitchen, a fire in the home or mould found behind a wall means a stressful conversation and a decision about whom to trust in minutes. Speed of response and calm, organised intake carry real weight, because the damage grows while the caller waits.',
    calls: [
      ['Water damage or flooding', 'Urgent', 'Source, whether the water is stopped, affected areas, and property type'],
      ['Fire or smoke damage', 'Urgent', 'Whether the property is safe to enter, areas affected, and insurer details if known'],
      ['Sewage or biohazard', 'Urgent', 'Type of contamination and areas affected'],
      ['Mould concern', 'Same week to routine', 'Where it was seen, how long, and any moisture source'],
      ['Storm damage', 'Urgent to same week', 'Type of damage and any temporary protection'],
      ['Insurance or estimate question', 'Routine', 'Insurer name, claim status and what the caller needs'],
    ],
    urgent: [
      'Active water intrusion or standing water in the property.',
      'Fire or smoke damage, where the caller’s safety and emergency services come first.',
      'Sewage backup or contamination.',
    ],
    routine: [
      'Mould inspections with no active water source.',
      'Questions about an existing claim.',
      'Follow-up scheduling after the initial response.',
    ],
    questions: [
      'Has the source of the water, fire or damage been stopped, and is anyone at risk?',
      'Which rooms or areas are affected, and roughly how large is the area?',
      'Is the property occupied, and is it safe to enter?',
      'Is there an insurer involved, and does the caller have a claim number?',
      'Who is on site and able to meet a crew, and what are the access arrangements?',
    ],
    seasonal:
      'Restoration work follows storms, freezes and the occasional household failure, so demand is both seasonal and unpredictable. Because delay increases damage, the first conversation matters more here than in most trades. Answering every call and routing urgent ones to the on-call crew helps your team start the response sooner, and it gives callers a clear next step during a stressful moment.',
    handoff: [
      'Name, phone and address, plus who is on site.',
      'The type of loss, source status and affected areas.',
      'Insurer and claim details if the caller has them.',
      'The urgency classification and which on-call contact was alerted.',
    ],
    setup: [
      'List loss types you respond to, such as water, fire and mould, and any limits on size or hazard.',
      'Define the on-call chain for emergency response and how long each person has to acknowledge.',
      'Test a flood call, a fire call and an insurance question.',
    ],
    limits: [
      'Sarah does not advise on insurance coverage or what will be paid.',
      'She does not assess hazards remotely, so safety questions are routed to your team.',
      'In fires and similar incidents, emergency services take priority over any intake.',
    ],
    faqs: [
      { q: 'Can she speak calmly to someone in distress?', a: 'She is built to be clear and steady, and to move the call toward a next step. Where a caller needs a person, your escalation rules should route to one.' },
      { q: 'Does she gather insurance details?', a: 'She can ask for the insurer and claim number if the caller has them, and note them for your team. She does not interpret coverage.' },
      { q: 'What about commercial losses?', a: 'She can ask about property type and size and route commercial calls to the contact you specify.' },
    ],
  },
  locksmith: {
    name: 'Locksmith',
    audience: 'locksmiths',
    intro:
      'Locksmith calls are dominated by urgency. A person locked out of a home or car wants reassurance and an arrival time immediately, and will call someone else if they reach voicemail. Intake has to be quick, clear and careful about who is asking for access.',
    calls: [
      ['Home lockout', 'Urgent', 'Address, lock type, and whether anyone is waiting outside'],
      ['Vehicle lockout', 'Urgent', 'Location, vehicle make and year, and whether anyone is inside'],
      ['Lost keys and rekeying', 'Same day to routine', 'Number of locks and the reason for the change'],
      ['Broken key or lock', 'Same day', 'Which lock and what has failed'],
      ['Safe opening', 'Routine', 'Safe type and the situation'],
      ['Security upgrade', 'Routine, high value', 'Property type and the upgrade requested'],
    ],
    urgent: [
      'Any lockout in unsafe conditions, such as extreme weather, night-time in an isolated location or a vulnerable person waiting.',
      'A child or animal locked inside a vehicle, where emergency services come first.',
      'A break-in with the property left insecure.',
    ],
    routine: [
      'Rekeying after a move.',
      'Key copying and duplicate requests.',
      'Security upgrades and smart lock installations.',
    ],
    questions: [
      'Where is the caller right now, and is the location safe?',
      'Is the lock on a home, a vehicle or a business, and what type of lock is it?',
      'Is anyone or any animal inside who could be at risk?',
      'Is the caller able to show proof of residence or ownership when the technician arrives?',
      'Can the caller wait at the address, and what is the best contact number?',
    ],
    seasonal:
      'Lockouts are unpredictable and cluster late at night, in bad weather and around holidays. The highest-value jobs are often after hours, when few competitors answer. Round-the-clock coverage lets you capture the location, urgency and lock details immediately, so the on-call locksmith can respond to the right job without a callback chase.',
    handoff: [
      'Name, phone and the exact location, including how to find the caller.',
      'The lock or vehicle type and what the caller needs.',
      'Safety concerns noted, such as weather or a vulnerable person.',
      'The urgency classification and which technician was alerted.',
    ],
    setup: [
      'List home, vehicle and business services, plus the coverage radius, since arrival time depends on distance.',
      'Decide what counts as a safety-critical lockout, and who receives the immediate alert.',
      'Test a night-time lockout, a rekey request and a request outside your radius.',
    ],
    limits: [
      'Sarah cannot verify identity or ownership. Your technician confirms entitlement on site, following your policy.',
      'She does not give lockpicking or bypass instructions.',
      'Arrival estimates depend on where your technicians are, so she gives only what your system supports.',
    ],
    faqs: [
      { q: 'How does she handle someone who sounds suspicious?', a: 'She follows the rules you give her and records what the caller says. Verification and the decision to proceed stay with your technician and your policy.' },
      { q: 'Can she give an arrival time?', a: 'Only if your setup provides one. Otherwise she tells the caller that dispatch will confirm and alerts the on-call contact.' },
      { q: 'Does she handle vehicle lockouts?', a: 'Yes, if you offer them. She asks for vehicle and location details and flags safety risks such as a child or animal inside.' },
    ],
  },
  'pest-control': {
    name: 'Pest Control',
    audience: 'pest control companies',
    intro:
      'Pest control callers have usually just discovered a problem, and they want reassurance and a plan. Many are also existing customers on recurring plans who call to reschedule. Both groups reach your phone at the same time as your technicians are out on routes.',
    calls: [
      ['Active infestation', 'Same day where possible', 'Pest type, location in the property, and how long it has been seen'],
      ['Termite concern', 'Soon, high value', 'Signs observed, property type, and any prior treatment'],
      ['Rodents or wildlife', 'Same day to soon', 'Where activity is seen, noises, and any food safety concerns'],
      ['Stinging insects', 'Urgent if allergy or heavy activity', 'Where the nest is, how close to people, and any allergy risk'],
      ['Recurring plan visit', 'Routine', 'Plan details, preferred time and any access notes'],
      ['Inspection or quote', 'Routine', 'Property type, size and the concern'],
    ],
    urgent: [
      'Stinging insects near people, especially where someone has a known allergy.',
      'Heavy infestations in food areas or care settings.',
      'Bed bug reports from a rental property or hotel where timing is critical.',
    ],
    routine: [
      'Recurring quarterly or monthly service visits.',
      'Preventive inspections.',
      'Quotes for exclusion or sealing work.',
    ],
    questions: [
      'What have you seen, where, and how long has it been happening?',
      'Is the property a home, a rental or a business, and who is responsible for treatment?',
      'Are there children, pets or people with allergies or health conditions in the space?',
      'Has the property been treated before, and by whom?',
      'Is anyone available to provide access on the visit date?',
    ],
    seasonal:
      'Pest activity is highly seasonal. Ants and wasps surge in spring and summer, rodents move indoors in autumn, and termite swarms appear at predictable times. Recurring plans also create a steady drip of reschedule calls. Instant answering keeps both flows from clogging your phone, while the intake questions help your office decide which visits can wait and which cannot.',
    handoff: [
      'Name, phone and address.',
      'The pest, location of activity and any health or safety concern.',
      'Whether the caller is a plan member or a new customer.',
      'The urgency classification and any appointment booked.',
    ],
    setup: [
      'List the pests, property types and treatment categories you offer, and the areas you serve.',
      'Define which situations are same-day, such as allergy-related stinging insect calls.',
      'Test an active infestation call, a plan reschedule and an out-of-area request.',
    ],
    limits: [
      'Sarah does not recommend products or treatments, and she does not give chemical safety advice beyond what you have approved.',
      'She cannot identify a pest from a description with certainty, so inspections are booked.',
      'Where a caller reports a medical reaction, emergency services come first.',
    ],
    faqs: [
      { q: 'Can she manage recurring-plan reschedules?', a: 'She can offer new slots against your calendar and update the booking, which removes a large share of routine office calls.' },
      { q: 'Does she tell callers what treatment will be used?', a: 'No. Treatment decisions follow an inspection by your technician, so she books the visit and records the concern.' },
      { q: 'How does she handle commercial accounts?', a: 'She captures the business type and the issue and routes to the contact you specify, since commercial work usually involves contracts and compliance steps.' },
    ],
  },
  'lawn-care': {
    name: 'Lawn Care & Landscaping',
    audience: 'lawn care and landscaping companies',
    intro:
      'Lawn and landscape businesses face two kinds of calls: a high volume of simple maintenance requests and a smaller number of valuable design and installation projects. When both go into the same queue, the large project can wait behind a mowing signup. Good intake keeps them separate.',
    calls: [
      ['New mowing or maintenance signup', 'Routine', 'Property size, frequency wanted, and the address'],
      ['Weather reschedule', 'Routine', 'Which visit, the preferred new date, and any gate or access notes'],
      ['Estimate for a design or install', 'Routine, high value', 'Project scope, area, budget range and timeline'],
      ['Irrigation problem', 'Same day to routine', 'Symptoms, location, and whether water is flowing where it should not'],
      ['Seasonal cleanup', 'Routine', 'Property size and the type of cleanup'],
      ['Storm or tree debris', 'Soon', 'What fell, where, and whether it blocks access'],
    ],
    urgent: [
      'A broken irrigation line or valve flooding a property.',
      'Storm debris that blocks a driveway or a walkway.',
    ],
    routine: [
      'Regular mowing, fertilisation and aeration visits.',
      'Weather-related reschedules.',
      'Seasonal cleanup and mulching requests.',
    ],
    questions: [
      'Is this a one-time job or a recurring service, and how often?',
      'What is the approximate property or lawn size, and is there a gate or pets?',
      'Is the request maintenance, or is it a design or installation project that needs an estimate?',
      'For irrigation, is water flowing now, and can it be shut off?',
      'What is the caller’s preferred day, and are there any access restrictions?',
    ],
    seasonal:
      'This trade peaks at the turn of the seasons. Spring brings a rush of new customers and fertilisation requests, and autumn brings cleanup and aeration. Weather also drives a constant stream of reschedules. Answering at every peak means new customers are signed up quickly, and routine changes are handled without pulling staff off routes.',
    handoff: [
      'Name, phone and property address with access notes.',
      'The service requested and whether it is recurring or one time.',
      'Property size or project scope.',
      'Any appointment booked or estimate requested.',
    ],
    setup: [
      'List the maintenance packages and project services you offer, and your service area.',
      'Separate maintenance signups from design and install estimates so each follows its own path.',
      'Test a new signup, a weather reschedule and a large landscaping enquiry.',
    ],
    limits: [
      'Sarah does not price custom landscape projects, which need a site visit.',
      'Weather-based rescheduling decisions are yours, and she follows the rules you set for them.',
      'She cannot assess lawn health or plant problems from a description.',
    ],
    faqs: [
      { q: 'Can she move a whole route for a rain day?', a: 'She handles individual customer reschedule requests. Rescheduling an entire route is an operational decision your team makes, then communicates through your messaging setup.' },
      { q: 'Can she distinguish a mowing request from a design project?', a: 'Yes. She asks about scope and goals and routes large projects to a callback with the details already collected.' },
      { q: 'How does recurring service get set up?', a: 'She captures frequency and property details, then books the first visit or passes the lead to your office to finalise a plan.' },
    ],
  },
  cleaning: {
    name: 'Cleaning',
    audience: 'cleaning companies',
    intro:
      'Cleaning companies take calls while crews are mid-clean, and many callers are existing clients adjusting a schedule. New enquiries, recurring changes and commercial contract questions all need different handling, and mixing them wastes office time.',
    calls: [
      ['New recurring client', 'Routine, high value', 'Property size, frequency and preferred days'],
      ['One-time deep clean', 'Routine', 'Property size, condition and the date wanted'],
      ['Move-out or move-in clean', 'Time-sensitive', 'Move date, property size and any handover deadline'],
      ['Skip or reschedule a visit', 'Routine', 'The visit and the preferred alternative'],
      ['Commercial enquiry', 'Routine, high value', 'Business type, premises size and hours of access'],
      ['Complaint or quality issue', 'Same day', 'What was missed, when, and what the caller wants'],
    ],
    urgent: [
      'A quality complaint from an existing client, which deserves a prompt personal response.',
      'A move-out clean with a very near handover date.',
    ],
    routine: [
      'Recurring visit changes.',
      'Quotes for standard residential cleans.',
      'Commercial contract enquiries.',
    ],
    questions: [
      'How many bedrooms and bathrooms, or how large is the premises?',
      'Is this a one-time clean, a recurring service or a move-out clean?',
      'What day and time suit, and how flexible is the caller?',
      'Are there pets, special surfaces or specific areas the caller wants prioritised?',
      'How will the team get access, noting that sensitive codes should be handled by your staff rather than over the phone?',
    ],
    seasonal:
      'Cleaning demand rises before holidays, at the end of leases and in spring. Reschedules cluster around holidays and weather. Because many callers are existing clients, handling skip and reschedule requests automatically against your calendar can recover a large amount of office time. New-client calls during busy seasons are captured, not lost to voicemail.',
    handoff: [
      'Name, phone and address.',
      'Service type, property size and frequency.',
      'Requested dates and access arrangements, without sensitive codes.',
      'Any quote requested or booking made.',
    ],
    setup: [
      'List service types, such as recurring, deep and move-out cleaning, and your service area.',
      'Decide how commercial enquiries and complaints are routed and to whom.',
      'Test a new client call, a skip request and a complaint.',
    ],
    limits: [
      'Sarah should not collect alarm codes or key details; leave those for your staff to arrange securely.',
      'Pricing depends on your own rate rules, so she quotes only what you have configured.',
      'Complaints are best handled by a person, so she captures details and escalates.',
    ],
    faqs: [
      { q: 'Can she quote a cleaning price?', a: 'Only if you have given her rules for it, such as rates by property size. Otherwise she captures the details and books a quote or callback.' },
      { q: 'What about access instructions?', a: 'She can note that access arrangements exist and who will provide them. Sensitive codes are better exchanged through a channel your team controls.' },
      { q: 'Can she handle a skipped-visit request?', a: 'Yes, she can adjust the booking against your calendar according to your rules about notice and fees.' },
    ],
  },
  'pool-service': {
    name: 'Pool Service',
    audience: 'pool service companies',
    intro:
      'Pool callers range from a weekly customer asking about timing to someone with a green pool or a failed pump before a gathering. Equipment failures can also raise safety and water-loss concerns. Intake has to separate those quickly while technicians are out on routes.',
    calls: [
      ['Green or cloudy water', 'Same day to soon', 'Pool size, how long, and recent weather or use'],
      ['Pump, heater or filter failure', 'Same day', 'Which equipment, symptoms and any visible leaks'],
      ['Suspected leak or water loss', 'Soon', 'How much water is lost and how quickly'],
      ['Weekly service signup', 'Routine, recurring', 'Pool type, size and preferred day'],
      ['Opening or closing', 'Seasonal', 'Pool type and the date wanted'],
      ['Safety concern', 'Urgent', 'The hazard, such as damaged drain covers or fencing issues'],
    ],
    urgent: [
      'A safety hazard around the pool, such as a damaged drain cover or a broken gate where children may be present.',
      'Equipment failing with visible water leaking.',
      'A pool needing treatment before a planned event with very little notice.',
    ],
    routine: [
      'Weekly maintenance visits and schedule questions.',
      'Seasonal opening and closing.',
      'Quotes for equipment upgrades.',
    ],
    questions: [
      'Is it a chlorine, saltwater or other type of pool, and about how large?',
      'What does the water look like, and how long has it been that way?',
      'Which equipment is failing, and is anything leaking or making unusual noise?',
      'Is the pool above ground or in ground, and is there a heater or cover?',
      'Is there an event or a deadline that makes the timing sensitive?',
    ],
    seasonal:
      'Pool work is strongly seasonal. Openings cluster in spring, closings in autumn, and heat waves increase green-pool and equipment calls. Weekly customers also call for scheduling changes. Answering at all times removes the bottleneck at seasonal peaks and keeps your route staff focused on service.',
    handoff: [
      'Name, phone and address with gate or access notes.',
      'The problem, equipment involved and urgency.',
      'Whether the caller is a weekly customer or a new lead.',
      'Any visit booked or callback requested.',
    ],
    setup: [
      'List maintenance plans, repair and seasonal services and your coverage area.',
      'Decide which equipment failures and safety hazards trigger an immediate alert.',
      'Test a green-pool call, a pump failure and a weekly signup.',
    ],
    limits: [
      'Sarah does not give chemical dosing or water-treatment advice unless you have approved it.',
      'Safety hazards are escalated to your team, and emergencies to emergency services.',
      'She cannot diagnose equipment faults remotely, so visits are booked.',
    ],
    faqs: [
      { q: 'Can she handle seasonal openings and closings?', a: 'Yes. She books them against your calendar and captures pool type and timing so scheduling can be planned efficiently.' },
      { q: 'Does she advise on chemicals?', a: 'No, unless you place specific approved guidance in your knowledge base. Treatment decisions belong with your technician.' },
      { q: 'How are leak enquiries handled?', a: 'She records how much water is being lost and over what period, then books a leak assessment where you offer one.' },
    ],
  },
  'appliance-repair': {
    name: 'Appliance Repair',
    audience: 'appliance repair companies',
    intro:
      'For a household, a broken refrigerator or washer is an emergency even when it is routine for your team. Callers also tend to know less about their appliance than you need. Capturing the brand, model and symptom on the first call saves a diagnostic trip and helps with parts.',
    calls: [
      ['Refrigerator or freezer failure', 'Same day if possible', 'Brand, model, symptom, and whether food is at risk'],
      ['Washer or dryer fault', 'Soon', 'Brand, model, error codes, and any leaking'],
      ['Dishwasher issue', 'Routine to soon', 'Brand, symptom and any water damage'],
      ['Oven or range fault', 'Routine to soon', 'Gas or electric, brand, and the symptom'],
      ['Warranty service', 'Routine', 'Warranty provider, claim details and purchase date'],
      ['Water leak from an appliance', 'Urgent', 'Source, whether the water supply is off, and the affected area'],
    ],
    urgent: [
      'A refrigerator or freezer failure with food at risk.',
      'A leaking appliance that is damaging floors or cabinets.',
      'A suspected gas smell from a gas oven or dryer, where the caller should leave and contact the gas utility or emergency services.',
    ],
    routine: [
      'Dishwasher and oven repairs with no safety concern.',
      'Warranty and extended-plan visits.',
      'Maintenance and installation requests.',
    ],
    questions: [
      'What is the appliance, its brand and model, and where is the model plate?',
      'What exactly is it doing, and is an error code showing?',
      'When did it start, and has anything changed recently?',
      'Is it under warranty or covered by a service plan, and with whom?',
      'Is food, flooring or a time-sensitive need at risk?',
    ],
    seasonal:
      'Appliance failures are less seasonal than most trades, but refrigerators fail more in heat, and holiday cooking exposes oven problems. Warranty and non-warranty calls arrive mixed together. Collecting the model, symptom and warranty status up front means your dispatcher can pair the right technician and parts with the call.',
    handoff: [
      'Name, phone and address.',
      'Appliance type, brand, model and symptom or error code.',
      'Warranty status and provider where known.',
      'Urgency classification and any appointment booked.',
    ],
    setup: [
      'List the appliance categories and brands you service, and any you decline.',
      'Decide what counts as same-day, such as spoilage risk, and how warranty calls are routed.',
      'Test a refrigerator failure, a warranty call and an unsupported brand.',
    ],
    limits: [
      'Sarah does not diagnose faults or promise that a part is available.',
      'Warranty approval comes from the provider, not from her.',
      'Gas and electrical safety concerns are escalated according to your rules, with emergency services first.',
    ],
    faqs: [
      { q: 'Can she record the model number?', a: 'She can ask for it and note it, or note that the caller will send a photo of the plate, depending on your process.' },
      { q: 'How are warranty jobs different?', a: 'She captures the warranty provider and details, then routes the job according to the process you define for those claims.' },
      { q: 'Can she decline brands you do not service?', a: 'Yes, if you list the brands you cover, she can politely tell callers when something is outside your scope.' },
    ],
  },
  solar: {
    name: 'Solar',
    audience: 'solar companies',
    intro:
      'Solar businesses receive two very different callers: prospects who want a new installation and existing owners asking about monitoring alerts, inverter faults or production drops. The first group is time-sensitive and high-value. The second group needs fast triage. Treating them the same wastes both.',
    calls: [
      ['New installation enquiry', 'Routine, high value', 'Homeownership, roof details, energy use and timing'],
      ['Monitoring alert or production drop', 'Soon', 'System details, alert message and when it began'],
      ['Inverter fault', 'Same day to soon', 'Error code, whether the system has stopped, and any visible damage'],
      ['Maintenance or cleaning', 'Routine', 'System size, age and the reason for the visit'],
      ['Warranty claim', 'Routine', 'Installer, equipment and the issue'],
      ['Financing or incentive question', 'Routine', 'The question, passed to your sales team'],
    ],
    urgent: [
      'Visible damage, burning smell or smoke from solar equipment, where emergency services come first.',
      'A complete system shutdown reported with an electrical concern.',
    ],
    routine: [
      'New installation enquiries and site assessments.',
      'Monitoring and production questions.',
      'Maintenance requests and warranty questions.',
    ],
    questions: [
      'Does the caller own the home, and is it a single-family property?',
      'How old is the roof, and is there any shading or planned roof work?',
      'What are the typical electricity bills, or what is the caller trying to save?',
      'For existing owners, what is the installer, system size and the alert shown?',
      'Is this a sales enquiry or a service issue, which changes the routing entirely?',
    ],
    seasonal:
      'Interest in solar tends to rise with energy price news, incentive deadlines and summer bills, and installers see bursts of enquiries after promotions. Those leads cool quickly if no one responds. Fast capture of homeownership, roof and usage details gives your sales team a qualified starting point, while service calls are routed to the right team.',
    handoff: [
      'Name, phone and property address.',
      'Whether the caller is a prospect or an existing owner.',
      'For prospects, ownership, roof and energy-use details they provided.',
      'For owners, the system information, alert and urgency.',
    ],
    setup: [
      'Separate sales and service paths, and decide who receives each.',
      'Define which service symptoms are urgent and which can be handled during normal hours.',
      'Test a new-install enquiry, a monitoring alert and a warranty question.',
    ],
    limits: [
      'Sarah does not give quotes, savings estimates or financing advice. Those go to your sales team.',
      'She cannot troubleshoot systems remotely beyond what you have approved.',
      'Incentive and tax questions should be answered by your qualified staff.',
    ],
    faqs: [
      { q: 'Can she qualify solar leads?', a: 'She asks the questions you define, such as ownership, roof age and usage, and passes the answers to your team so the first callback is informed.' },
      { q: 'How are existing owners separated from prospects?', a: 'She asks early whether the caller already has a system and routes sales and service calls to different contacts.' },
      { q: 'Does she book site assessments?', a: 'Yes, where you offer them, against the availability in your connected calendar.' },
    ],
  },
  painting: {
    name: 'Painting',
    audience: 'painting companies',
    intro:
      'Painting businesses live on estimates. Each new enquiry is a chance to bid, and crews are on site all day, so calls go unanswered when they matter most. Residential and commercial projects also need different questions. Quick, organised intake turns enquiries into booked estimate visits.',
    calls: [
      ['Interior painting enquiry', 'Routine, high value', 'Rooms, ceiling height, condition and timeline'],
      ['Exterior painting enquiry', 'Routine, high value', 'Building size, surface type and access concerns'],
      ['Cabinet refinishing', 'Routine', 'Number of cabinets, current finish and timeline'],
      ['Commercial project', 'Routine, high value', 'Business type, area, hours of access and decision maker'],
      ['Touch-up or warranty issue', 'Routine to same week', 'Where, what happened and when the work was done'],
      ['Estimate follow-up', 'Routine', 'Which quote and the customer’s response'],
    ],
    urgent: [
      'A defect complaint on a recent job, which deserves prompt acknowledgement.',
      'Time-limited projects before a sale, move-in or event.',
    ],
    routine: [
      'New estimate requests.',
      'Colour or scheduling questions.',
      'Follow-up on quotes already sent.',
    ],
    questions: [
      'Is the project interior, exterior, cabinets or a mix?',
      'Roughly how many rooms or how many square feet, and what is the ceiling height?',
      'How old is the property, since older homes may need extra preparation or precautions your team handles?',
      'Is the property occupied, and is there a deadline such as a sale or a move?',
      'Is this residential or commercial, and who makes the final decision?',
    ],
    seasonal:
      'Exterior painting is concentrated in dry, mild months, while interior work spreads across the year and rises before holidays and property sales. Because estimates are the bottleneck, answering during work hours and capturing scope immediately lets you schedule visits efficiently. Follow-up on quotes matters just as much, since many customers decide weeks after the first estimate.',
    handoff: [
      'Name, phone and property address.',
      'Project type, scope and timeline.',
      'Property age and occupancy where the caller knows them.',
      'The estimate visit booked, or a request for a callback.',
    ],
    setup: [
      'List the project types you take, such as interior, exterior, cabinets and commercial, and your service area.',
      'Decide the minimum project size you accept and how smaller jobs are handled.',
      'Test a large residential enquiry, a commercial lead and a small touch-up request.',
    ],
    limits: [
      'Sarah does not provide firm prices, because quotes need a site visit.',
      'She does not make colour or product recommendations unless you have approved guidance.',
      'Hazard questions about older paint are for your estimator to address on site.',
    ],
    faqs: [
      { q: 'Can she tell residential from commercial?', a: 'Yes. She asks early and follows the qualifying questions and routing you set for each, so a commercial lead reaches the right person.' },
      { q: 'Does she book estimate visits?', a: 'Yes, against your real calendar availability, and she confirms the details with the caller before the call ends.' },
      { q: 'What happens to quotes that go quiet?', a: 'On plans that include the follow-up engine, quotes that stall can receive a polite nudge by email and SMS, which keeps open bids from being forgotten.' },
    ],
  },
};

export const INDUSTRY_DEEP: Record<string, DeepContentData> = Object.fromEntries(
  Object.entries(TRADES).map(([slug, t]) => [slug, build(t)]),
);

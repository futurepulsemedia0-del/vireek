import {
  Sparkles,
  PhoneCall,
  TrendingUp,
  Wrench,
  Link2,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';

export interface GlossaryCategory {
  slug: string;
  name: string;
  icon: LucideIcon;
}

export const GLOSSARY_CATEGORIES: GlossaryCategory[] = [
  { slug: 'ai-voice', name: 'AI & Voice Technology', icon: Sparkles },
  { slug: 'telephony', name: 'Call Handling & Telephony', icon: PhoneCall },
  { slug: 'growth', name: 'Leads & Revenue', icon: TrendingUp },
  { slug: 'industry', name: 'Home Service Industry', icon: Wrench },
  { slug: 'integrations', name: 'CRM & Integrations', icon: Link2 },
  { slug: 'security', name: 'Security & Compliance', icon: ShieldCheck },
];

export interface RelatedLink {
  label: string;
  href: string;
}

export interface GlossaryTerm {
  slug: string;
  term: string;
  category: string; // GlossaryCategory['slug']
  definition: string;
  relatedLinks?: RelatedLink[];
}

export const GLOSSARY_TERMS: GlossaryTerm[] = [
  // ---------- AI & Voice Technology ----------
  {
    slug: 'ai-voice-receptionist',
    term: 'AI Voice Receptionist',
    category: 'ai-voice',
    definition:
      'Software that answers incoming phone calls in a natural-sounding voice, asks qualifying questions, and captures caller details the way a human front-desk employee would — without breaks, sick days, or after-hours gaps. Vireek\u2019s AI voice receptionist, Sarah, is built specifically for home service businesses.',
    relatedLinks: [
      { label: 'See how Vireek works', href: '/platform' },
      { label: 'Compare features', href: '/features' },
    ],
  },
  {
    slug: 'conversational-ai',
    term: 'Conversational AI',
    category: 'ai-voice',
    definition:
      'A class of AI systems designed to hold natural, back-and-forth conversations rather than follow a rigid script or menu tree. Conversational AI understands follow-up questions, interruptions, and context from earlier in the same call.',
    relatedLinks: [{ label: 'Explore the Platform', href: '/platform' }],
  },
  {
    slug: 'nlp',
    term: 'Natural Language Processing (NLP)',
    category: 'ai-voice',
    definition:
      'The branch of AI that lets software understand and generate human language. NLP is what allows an AI receptionist to parse a caller saying "my AC stopped blowing cold air" and recognize it as a no-cool HVAC issue rather than a billing question.',
  },
  {
    slug: 'speech-to-text',
    term: 'Speech-to-Text (STT)',
    category: 'ai-voice',
    definition:
      'The technology that converts a caller\u2019s spoken words into written text in real time, so an AI system can interpret and respond to what was said. Accuracy in noisy environments — a caller standing outside near traffic, for example — is one of the harder problems in voice AI.',
  },
  {
    slug: 'text-to-speech',
    term: 'Text-to-Speech (TTS)',
    category: 'ai-voice',
    definition:
      'The technology that converts written text back into spoken audio, giving an AI receptionist its voice. Modern TTS engines produce natural pacing, tone, and inflection instead of the robotic cadence older systems were known for.',
  },
  {
    slug: 'intent-recognition',
    term: 'Intent Recognition',
    category: 'ai-voice',
    definition:
      'The process of identifying what a caller actually wants — booking a repair, checking on an existing job, asking about pricing — from the words they use, even when they phrase the request differently than expected.',
  },
  {
    slug: 'call-transcription',
    term: 'Call Transcription',
    category: 'ai-voice',
    definition:
      'A written, searchable record of everything said during a call. Transcripts let office staff review what an AI receptionist captured without having to re-listen to the full audio recording.',
    relatedLinks: [{ label: 'Read the Calls dashboard overview', href: '/features' }],
  },
  {
    slug: 'ai-agent',
    term: 'AI Agent',
    category: 'ai-voice',
    definition:
      'A software system that can carry out a task on its own — such as answering a call, asking qualifying questions, and logging the result — rather than simply responding to a single prompt. An AI voice receptionist is a specific type of AI agent focused on phone conversations.',
  },
  {
    slug: 'voice-ai',
    term: 'Voice AI',
    category: 'ai-voice',
    definition:
      'The umbrella term for AI systems that operate through spoken conversation rather than text or a screen. Voice AI combines speech-to-text, language understanding, and text-to-speech into a single real-time experience.',
  },
  {
    slug: 'llm',
    term: 'Large Language Model (LLM)',
    category: 'ai-voice',
    definition:
      'An AI model trained on large amounts of text that can understand and generate human-like language. LLMs power the reasoning behind modern conversational AI, including how an AI receptionist decides which question to ask next.',
  },
  {
    slug: 'sentiment-analysis',
    term: 'Sentiment Analysis',
    category: 'ai-voice',
    definition:
      'The process of detecting a caller\u2019s tone or emotional state — frustrated, urgent, satisfied — from their words and speech patterns, so calls can be prioritized or flagged for a human follow-up when needed.',
  },
  {
    slug: 'call-summarization',
    term: 'Call Summarization',
    category: 'ai-voice',
    definition:
      'An AI-generated summary of a phone call that highlights the key details — the issue reported, the address, the urgency level — so a technician or office manager can get up to speed in seconds instead of reading a full transcript.',
  },
  {
    slug: 'barge-in',
    term: 'Barge-In',
    category: 'ai-voice',
    definition:
      'The ability for a caller to interrupt the AI mid-sentence and have it stop talking and listen, the same way a human would naturally yield the floor. Systems without barge-in feel stiff because callers have to wait out a full prompt before speaking.',
  },
  {
    slug: 'latency-voice-ai',
    term: 'Latency (Voice AI)',
    category: 'ai-voice',
    definition:
      'The delay between when a caller finishes speaking and when the AI responds. Low latency is critical for a natural-feeling conversation — noticeable pauses make callers think the line dropped or the system is confused.',
  },
  {
    slug: 'turn-taking',
    term: 'Turn-Taking',
    category: 'ai-voice',
    definition:
      'The back-and-forth rhythm of a conversation — knowing when to speak and when to listen. Good turn-taking is what separates a natural-sounding AI call from one that feels like talking to a phone tree.',
  },
  {
    slug: 'ai-hallucination',
    term: 'Hallucination (AI)',
    category: 'ai-voice',
    definition:
      'When an AI system states something false or invented with apparent confidence — for example, quoting a price or policy that was never configured. Well-built voice AI systems constrain responses to verified business information to minimize this risk.',
  },
  {
    slug: 'ivr',
    term: 'IVR (Interactive Voice Response)',
    category: 'ai-voice',
    definition:
      'The older "press 1 for sales, press 2 for support" phone menu technology. IVR routes calls based on button presses rather than understanding natural speech, which is why it frustrates callers with anything but the simplest requests.',
    relatedLinks: [{ label: 'AI receptionist vs. answering service', href: '/blog/ai-receptionist-vs-answering-service' }],
  },
  {
    slug: 'call-script',
    term: 'Call Script',
    category: 'ai-voice',
    definition:
      'The structured set of questions and talking points used to handle a call consistently — not necessarily word-for-word dialogue, but a defined order of information to gather, such as service needed, location, and urgency.',
    relatedLinks: [{ label: 'The anatomy of a perfect call script', href: '/blog/perfect-call-script-home-services' }],
  },

  // ---------- Call Handling & Telephony ----------
  {
    slug: 'missed-call',
    term: 'Missed Call',
    category: 'telephony',
    definition:
      'An inbound call that goes unanswered, whether it rings out, hits voicemail, or is declined. For home service businesses, a missed call is rarely a callback opportunity — most callers move straight to the next business on their list.',
    relatedLinks: [{ label: 'Why every missed call is a lost job', href: '/blog/cost-of-a-missed-call' }],
  },
    {
    slug: 'sms-text-back',
    term: 'SMS Text-Back',
    category: 'telephony',
    definition:
      'An automatic text message sent to a caller within seconds of a missed or unanswered call, apologizing for missing them and including a link to book — so a lead isn\u2019t lost just because nobody picked up in time.',
    relatedLinks: [{ label: 'See SMS Text-Back', href: '/features/sms-text-back' }],
  },
  {
    slug: 'call-forwarding',
    term: 'Call Forwarding',
    category: 'telephony',
    definition:
      'Redirecting calls from one number to another automatically — for example, forwarding your existing business line to Vireek so customers keep dialing the number they already know while an AI receptionist answers.',
  },
  {
    slug: 'call-routing',
    term: 'Call Routing',
    category: 'telephony',
    definition:
      'The logic that decides where an inbound call should go — a specific technician, a department, voicemail, or an AI receptionist — often based on time of day, caller history, or the reason for the call.',
  },
  {
    slug: 'call-overflow',
    term: 'Call Overflow',
    category: 'telephony',
    definition:
      'What happens to calls that arrive when your team is already on the phone or unavailable. Overflow calls are the ones most likely to go to voicemail unless a backup system, such as an AI receptionist, is in place to catch them.',
  },
  {
    slug: 'after-hours-answering',
    term: 'After-Hours Answering',
    category: 'telephony',
    definition:
      'Handling calls that come in outside normal business hours — nights, weekends, holidays — when most home service businesses would otherwise send callers to voicemail.',
    relatedLinks: [{ label: 'See 24/7 answering in action', href: '/demo' }],
  },
  {
    slug: 'call-queue',
    term: 'Call Queue',
    category: 'telephony',
    definition:
      'A holding line for calls waiting to be answered when every available line or agent is busy. Long queues increase the chance a caller hangs up before ever speaking to anyone.',
  },
  {
    slug: 'voicemail',
    term: 'Voicemail',
    category: 'telephony',
    definition:
      'A recorded message left when a call goes unanswered. Voicemail was built for an era when callers expected to wait for a callback — an expectation most callers no longer have, especially for urgent home service needs.',
    relatedLinks: [{ label: 'Why voicemail doesn\u2019t solve this', href: '/blog/cost-of-a-missed-call' }],
  },
  {
    slug: 'live-transfer',
    term: 'Live Transfer',
    category: 'telephony',
    definition:
      'Connecting a caller directly to a live person in real time, often after an AI or automated system has already gathered the initial details — used for urgent or high-value calls that need immediate human judgment.',
  },
  {
    slug: 'warm-transfer',
    term: 'Warm Transfer',
    category: 'telephony',
    definition:
      'A call transfer where the receiving person is briefed on the caller\u2019s situation before being connected, so the customer doesn\u2019t have to repeat themselves from scratch.',
  },
  {
    slug: 'cold-transfer',
    term: 'Cold Transfer',
    category: 'telephony',
    definition:
      'A call transfer where the caller is passed along with no context given to the receiving person, forcing the customer to re-explain their issue from the beginning.',
  },
  {
    slug: 'call-recording',
    term: 'Call Recording',
    category: 'telephony',
    definition:
      'An audio capture of a phone conversation, kept for quality review, training, or dispute resolution. Recordings are typically stored alongside a transcript and should be protected with the same access controls as other customer data.',
    relatedLinks: [{ label: 'Read Vireek\u2019s Security practices', href: '/security' }],
  },
  {
    slug: 'voip',
    term: 'VoIP (Voice over Internet Protocol)',
    category: 'telephony',
    definition:
      'Technology that carries phone calls over the internet instead of traditional copper phone lines. VoIP is what makes it possible for an AI receptionist to answer, route, and record calls without any special hardware at your office.',
  },
  {
    slug: 'sip-trunking',
    term: 'SIP Trunking',
    category: 'telephony',
    definition:
      'A method of connecting a business phone system to the public phone network over the internet, using the Session Initiation Protocol. SIP trunking underlies most modern cloud-based call routing and forwarding setups.',
  },
  {
    slug: 'toll-free-number',
    term: 'Toll-Free Number',
    category: 'telephony',
    definition:
      'A phone number, such as one starting with 800 or 888, that costs the caller nothing to dial. Some home service businesses use a toll-free number for marketing while keeping a local number for their main line. Using one to send SMS requires Toll-Free Verification with the carrier first, or messages get filtered.',
    relatedLinks: [{ label: 'Toll-Free Verification', href: '/glossary/toll-free-verification' }],
  },
  {
    slug: 'toll-free-verification',
    term: 'Toll-Free Verification (TFV)',
    category: 'telephony',
    definition:
      'A one-time review carriers require before a toll-free number (800, 833, 844, 855, 866, 877, or 888) can send SMS reliably. You submit your business identity and how you plan to use the number; until it\u2019s approved, texts from that number can be filtered or blocked outright. It is a separate process from 10DLC, which covers local numbers instead.',
  },
  {
    slug: '10dlc',
    term: '10DLC',
    category: 'telephony',
    definition:
      '"10-Digit Long Code" \u2014 the registration system carriers require before a standard local phone number (not toll-free) can send SMS at scale. Like Toll-Free Verification, it exists to cut down on spam; unregistered numbers get their messages throttled or filtered.',
  },
  {
    slug: 'local-number',
    term: 'Local Number',
    category: 'telephony',
    definition:
      'A phone number with an area code matching the business\u2019s service region. Local numbers tend to build more trust with nearby customers than an unfamiliar toll-free or out-of-area number.',
  },
  {
    slug: 'caller-id',
    term: 'Caller ID',
    category: 'telephony',
    definition:
      'The information displayed about an incoming call, typically the caller\u2019s phone number and sometimes their name, used to identify returning customers before the call is even answered.',
  },
  {
    slug: 'dtmf',
    term: 'DTMF (Dual-Tone Multi-Frequency)',
    category: 'telephony',
    definition:
      'The technical name for the tones generated when someone presses a button on a phone keypad — the sound behind old-school "press 1 for sales" menus.',
  },
  {
    slug: 'call-analytics',
    term: 'Call Analytics',
    category: 'telephony',
    definition:
      'Reporting on call volume, answer rates, call outcomes, and trends over time, used to spot patterns like which hours generate the most missed calls or which service type drives the most inquiries.',
    relatedLinks: [{ label: 'See Analytics features', href: '/features' }],
  },
  {
    slug: 'answer-rate',
    term: 'Answer Rate',
    category: 'telephony',
    definition:
      'The percentage of inbound calls that are actually answered, as opposed to going to voicemail or ringing out. A low answer rate is one of the clearest warning signs of lost revenue for a home service business.',
    relatedLinks: [{ label: 'Estimate your missed-call cost', href: '/calculator' }],
  },
  {
    slug: 'first-call-resolution',
    term: 'First Call Resolution (FCR)',
    category: 'telephony',
    definition:
      'The percentage of caller issues fully resolved during the initial call, without needing a callback or additional follow-up. Higher FCR generally means happier customers and less repeat work for the office.',
  },
  {
    slug: 'average-handle-time',
    term: 'Average Handle Time (AHT)',
    category: 'telephony',
    definition:
      'The average length of a call from answer to hang-up, including any hold or transfer time. AHT is a useful efficiency metric, but should be balanced against call quality — a shorter call isn\u2019t better if it skips important details.',
  },
  {
    slug: 'hold-time',
    term: 'Hold Time',
    category: 'telephony',
    definition:
      'The amount of time a caller spends waiting before reaching a live person or getting a response. Extended hold times are one of the leading causes of caller abandonment.',
  },
  {
    slug: 'call-abandonment-rate',
    term: 'Call Abandonment Rate',
    category: 'telephony',
    definition:
      'The percentage of callers who hang up before their call is answered, often because of long hold times or a confusing phone menu. This metric is closely tied to lost job opportunities in home service businesses.',
  },

  // ---------- Leads & Revenue ----------
  {
    slug: 'lead-capture',
    term: 'Lead Capture',
    category: 'growth',
    definition:
      'The process of collecting a prospective customer\u2019s contact information and service request as soon as they reach out, so no interested caller falls through the cracks before your team follows up.',
    relatedLinks: [{ label: 'See Leads features', href: '/features' }],
  },
  {
    slug: 'lead-qualification',
    term: 'Lead Qualification',
    category: 'growth',
    definition:
      'Asking a defined set of questions to determine whether a caller is a good fit — inside the service area, a real job rather than a spam call, and clear about what they need — before dispatching a technician.',
  },
  {
    slug: 'lead-scoring',
    term: 'Lead Scoring',
    category: 'growth',
    definition:
      'Ranking incoming leads by how likely they are to convert into paying jobs, based on factors like urgency, service type, and location, so the highest-value opportunities get followed up first.',
  },
  {
    slug: 'conversion-rate',
    term: 'Conversion Rate',
    category: 'growth',
    definition:
      'The percentage of leads or calls that turn into actual booked jobs. Improving answer rates and call quality both tend to move this number directly.',
  },
  {
    slug: 'cost-per-lead',
    term: 'Cost Per Lead (CPL)',
    category: 'growth',
    definition:
      'How much a business spends, on average, to generate a single lead through advertising or marketing. CPL only tells half the story if a meaningful share of those leads are then lost to missed calls.',
  },
  {
    slug: 'booking-rate',
    term: 'Booking Rate',
    category: 'growth',
    definition:
      'The share of answered calls that result in a scheduled appointment. A well-run call process — whether human or AI — aims to move a ready caller to booking quickly rather than over-qualifying them.',
  },
  {
    slug: 'revenue-leakage',
    term: 'Revenue Leakage',
    category: 'growth',
    definition:
      'Revenue a business should have earned but lost due to operational gaps — missed calls, slow follow-up, or dropped leads — rather than a lack of demand.',
    relatedLinks: [{ label: 'Calculate your revenue leakage', href: '/calculator' }],
  },
  {
    slug: 'missed-call-cost',
    term: 'Missed Call Cost',
    category: 'growth',
    definition:
      'An estimate of the revenue lost from unanswered calls, typically calculated from call volume, close rate, and average ticket size. Many home service businesses are surprised how large this number is once they run it.',
    relatedLinks: [{ label: 'Use the Revenue Calculator', href: '/calculator' }],
  },
  {
    slug: 'customer-lifetime-value',
    term: 'Customer Lifetime Value (CLV)',
    category: 'growth',
    definition:
      'The total revenue a business can expect from a single customer across the full relationship, including repeat service calls, maintenance plans, and referrals — not just the first job.',
  },
  {
    slug: 'follow-up-automation',
    term: 'Follow-Up Automation',
    category: 'growth',
    definition:
      'Automatically reaching back out to leads or customers — through text, email, or a scheduled callback — without relying on someone remembering to do it manually.',
  },
  {
    slug: 'appointment-booking',
    term: 'Appointment Booking',
    category: 'growth',
    definition:
      'Scheduling a service visit directly during the initial call or follow-up, ideally synced to a live calendar so double-bookings and scheduling conflicts are avoided.',
    relatedLinks: [{ label: 'Google Calendar integration', href: '/integrations/google-calendar' }],
  },
  {
    slug: 'no-show-rate',
    term: 'No-Show Rate',
    category: 'growth',
    definition:
      'The percentage of booked appointments where the customer isn\u2019t present or available when the technician arrives, often reduced with confirmation calls or reminder messages.',
  },
  {
    slug: 'upsell',
    term: 'Upsell',
    category: 'growth',
    definition:
      'Offering a customer an additional or higher-value service related to their original request — for example, suggesting a maintenance plan alongside a one-time repair.',
  },
  {
    slug: 'job-costing',
    term: 'Job Costing',
    category: 'growth',
    definition:
      'Tracking the actual labor, materials, and overhead cost of completing a specific job, used to measure profitability per job rather than just per customer or per month.',
  },

  // ---------- Home Service Industry ----------
  {
    slug: 'dispatch',
    term: 'Dispatch',
    category: 'industry',
    definition:
      'The process of assigning a job to a technician and sending them to the customer\u2019s location, usually based on location, availability, and skill set.',
  },
  {
    slug: 'service-area',
    term: 'Service Area',
    category: 'industry',
    definition:
      'The geographic region a business is willing and able to travel to for jobs. Confirming a caller is within the service area early in a call avoids wasted dispatch time.',
  },
  {
    slug: 'truck-roll',
    term: 'Truck Roll',
    category: 'industry',
    definition:
      'Sending a technician and vehicle out to a physical job site. Every truck roll has a real cost in fuel, labor, and time, which is why accurate information gathered before dispatch matters so much.',
  },
  {
    slug: 'no-heat-no-cool',
    term: 'No-Heat / No-Cool Call',
    category: 'industry',
    definition:
      'Industry shorthand for an HVAC emergency call where a customer\u2019s heating or cooling system has stopped working entirely — these calls spike during extreme weather and rarely wait for business hours.',
    relatedLinks: [{ label: 'HVAC emergency call triage', href: '/blog/hvac-emergency-call-triage' }],
  },
  {
    slug: 'preventive-maintenance',
    term: 'Preventive Maintenance (PM)',
    category: 'industry',
    definition:
      'Scheduled service performed to keep equipment running well and catch small problems before they become expensive repairs — common for HVAC systems, water heaters, and other home equipment.',
  },
  {
    slug: 'flat-rate-pricing',
    term: 'Flat-Rate Pricing',
    category: 'industry',
    definition:
      'A pricing model where the customer is quoted a fixed price for a specific job before work begins, regardless of how long the job actually takes.',
  },
  {
    slug: 'time-and-materials',
    term: 'Time & Materials (T&M)',
    category: 'industry',
    definition:
      'A pricing model where the customer is billed based on the actual labor hours worked and materials used, rather than a single fixed quote.',
  },
  {
    slug: 'work-order',
    term: 'Work Order',
    category: 'industry',
    definition:
      'The internal record of a job — customer details, issue description, technician assigned, and status — used to track a request from the initial call through completion.',
  },
  {
    slug: 'technician-utilization',
    term: 'Technician Utilization',
    category: 'industry',
    definition:
      'The percentage of a technician\u2019s available working hours actually spent on billable jobs, as opposed to driving, waiting, or downtime.',
  },
  {
    slug: 'route-optimization',
    term: 'Route Optimization',
    category: 'industry',
    definition:
      'Planning technician schedules and driving routes to minimize travel time between jobs, allowing more appointments to be completed in a day.',
  },
  {
    slug: 'seasonal-demand',
    term: 'Seasonal Demand',
    category: 'industry',
    definition:
      'The predictable rise and fall in call volume tied to weather and time of year — for example, HVAC cooling calls spiking in summer and heating calls spiking in winter.',
  },
  {
    slug: 'home-service-business',
    term: 'Home Service Business',
    category: 'industry',
    definition:
      'A company that performs work at a customer\u2019s home or property, such as HVAC, plumbing, electrical, roofing, restoration, or locksmith services — the core market Vireek is built for.',
    relatedLinks: [{ label: 'Browse all industries', href: '/industries' }],
  },
  {
    slug: 'hvac',
    term: 'HVAC',
    category: 'industry',
    definition:
      'Heating, Ventilation, and Air Conditioning — the trade responsible for installing, repairing, and maintaining home climate-control systems. HVAC businesses see some of the sharpest seasonal call spikes of any home service trade.',
    relatedLinks: [{ label: 'Vireek for HVAC', href: '/industries/hvac' }],
  },
  {
    slug: 'plumbing',
    term: 'Plumbing',
    category: 'industry',
    definition:
      'The trade covering water supply, drainage, and gas piping systems in homes and buildings. Plumbing emergencies like burst pipes are highly time-sensitive and often arrive outside business hours.',
    relatedLinks: [{ label: 'Vireek for Plumbing', href: '/industries/plumbing' }, { label: 'Plumbing missed-call cost', href: '/blog/plumbing-missed-call-cost' }],
  },
  {
    slug: 'electrical-contractor',
    term: 'Electrical Contractor',
    category: 'industry',
    definition:
      'A licensed professional or business that installs, repairs, and maintains electrical wiring and systems in homes and buildings.',
    relatedLinks: [{ label: 'Vireek for Electrical', href: '/industries/electrical' }],
  },
  {
    slug: 'roofing-contractor',
    term: 'Roofing Contractor',
    category: 'industry',
    definition:
      'A business specializing in roof installation, repair, and replacement — often fielding a high volume of storm-related emergency calls in short bursts.',
    relatedLinks: [{ label: 'Vireek for Roofing', href: '/industries/roofing' }],
  },
  {
    slug: 'restoration-company',
    term: 'Restoration Company',
    category: 'industry',
    definition:
      'A business that responds to water, fire, mold, or storm damage to restore a property to its prior condition — work that is almost always urgent and unplanned by the customer.',
    relatedLinks: [{ label: 'Vireek for Restoration', href: '/industries/restoration' }],
  },
  {
    slug: 'locksmith',
    term: 'Locksmith',
    category: 'industry',
    definition:
      'A tradesperson specializing in locks, keys, and security hardware, frequently called for lockouts that require an immediate response regardless of time of day.',
    relatedLinks: [{ label: 'Vireek for Locksmith', href: '/industries/locksmith' }],
  },

  // ---------- CRM & Integrations ----------
  {
    slug: 'crm',
    term: 'CRM (Customer Relationship Management)',
    category: 'integrations',
    definition:
      'Software used to track customers, leads, and job history in one place. Syncing call data into a CRM automatically avoids double data entry and keeps every team member working from the same information.',
  },
  {
    slug: 'field-service-management',
    term: 'Field Service Management (FSM)',
    category: 'integrations',
    definition:
      'Software platforms built specifically for scheduling, dispatching, and managing technicians who work at customer locations, such as ServiceTitan, Housecall Pro, or Jobber.',
    relatedLinks: [
      { label: 'Vireek vs. ServiceTitan', href: '/compare/servicetitan' },
      { label: 'Vireek vs. Housecall Pro', href: '/compare/housecall-pro' },
      { label: 'Vireek vs. Jobber', href: '/compare/jobber' },
    ],
  },
  {
    slug: 'api-integration',
    term: 'API Integration',
    category: 'integrations',
    definition:
      'A connection between two software systems that lets them exchange data automatically, such as sending a captured lead from an AI receptionist directly into a CRM without manual entry.',
    relatedLinks: [{ label: 'Browse all integrations', href: '/integrations' }],
  },
  {
    slug: 'zapier',
    term: 'Zapier',
    category: 'integrations',
    definition:
      'A no-code automation platform that connects thousands of apps together, letting non-technical teams build custom workflows — such as sending a text message whenever a new lead is captured.',
    relatedLinks: [{ label: 'Zapier integration', href: '/integrations/zapier' }],
  },
  {
    slug: 'webhook',
    term: 'Webhook',
    category: 'integrations',
    definition:
      'An automated message sent from one system to another the moment a specific event happens — for example, notifying a CRM instantly when a new call is completed, rather than on a delay or a fixed schedule.',
  },
  {
    slug: 'quickbooks-sync',
    term: 'QuickBooks Sync',
    category: 'integrations',
    definition:
      'Automatically connecting call and job data with QuickBooks accounting records, reducing manual bookkeeping and keeping invoicing aligned with actual completed work.',
    relatedLinks: [{ label: 'QuickBooks integration', href: '/integrations/quickbooks' }],
  },
  {
    slug: 'two-way-sync',
    term: 'Two-Way Sync',
    category: 'integrations',
    definition:
      'A data connection where updates flow in both directions between two systems — a change made in one, like a rescheduled appointment, automatically reflects in the other.',
    relatedLinks: [{ label: 'Google Calendar integration', href: '/integrations/google-calendar' }],
  },
  {
    slug: 'sso',
    term: 'Single Sign-On (SSO)',
    category: 'integrations',
    definition:
      'A login system that lets a user access multiple connected tools with one set of credentials, reducing password fatigue and centralizing account security.',
  },

  // ---------- Security & Compliance ----------
  {
    slug: 'row-level-security',
    term: 'Row Level Security (RLS)',
    category: 'security',
    definition:
      'A database-level protection that restricts which rows of data a given account can read or write, enforced by the database itself rather than only by application code. Vireek scopes every policy to the authenticated account so one business can never query another\u2019s data.',
    relatedLinks: [{ label: 'Read the Security page', href: '/security' }],
  },
  {
    slug: 'data-encryption',
    term: 'Data Encryption',
    category: 'security',
    definition:
      'Converting data into a coded form that can only be read with the correct decryption key, protecting sensitive information such as customer addresses and call transcripts from unauthorized access.',
  },
  {
    slug: 'encryption-at-rest',
    term: 'Encryption at Rest',
    category: 'security',
    definition:
      'Encrypting data while it is stored on a disk or in a database, so that even if the underlying storage were somehow accessed directly, the data itself would remain unreadable.',
  },
  {
    slug: 'encryption-in-transit',
    term: 'Encryption in Transit',
    category: 'security',
    definition:
      'Encrypting data while it travels between systems — for example, between a caller\u2019s phone and Vireek\u2019s servers — so it cannot be intercepted and read along the way.',
  },
  {
    slug: 'audit-log',
    term: 'Audit Log',
    category: 'security',
    definition:
      'A recorded history of sensitive actions taken within a system, such as permission changes or deleted records, so administrators can review exactly what happened and when.',
    relatedLinks: [{ label: 'Data security checklist for AI vendors', href: '/blog/ai-vendor-security-checklist' }],
  },
  {
    slug: 'rbac',
    term: 'Role-Based Access Control (RBAC)',
    category: 'security',
    definition:
      'A security model that grants different levels of access based on a person\u2019s role — for example, a technician sees only their assigned jobs, while an office manager sees the full call and lead history.',
  },
  {
    slug: 'soc-2',
    term: 'SOC 2',
    category: 'security',
    definition:
      'An independent audit standard that evaluates how a company protects customer data across security, availability, and confidentiality. Businesses often ask vendors whether they are SOC 2 compliant before sharing customer information.',
    relatedLinks: [{ label: 'Trust Center', href: '/trust' }],
  },
  {
    slug: 'gdpr',
    term: 'GDPR',
    category: 'security',
    definition:
      'The General Data Protection Regulation — a European Union law governing how personal data is collected, stored, and used, with significant requirements around consent and the right to have data deleted.',
  },
  {
    slug: 'mfa',
    term: 'Multi-Factor Authentication (MFA)',
    category: 'security',
    definition:
      'A login security method requiring more than just a password — typically a code from a phone or authenticator app — to confirm a user\u2019s identity and reduce the risk of unauthorized account access.',
  },
  {
    slug: 'data-retention-policy',
    term: 'Data Retention Policy',
    category: 'security',
    definition:
      'The rules a company sets for how long it keeps different types of data, such as call recordings or transcripts, before securely deleting them.',
  },
  {
    slug: 'pci-dss',
    term: 'PCI DSS',
    category: 'security',
    definition:
      'The Payment Card Industry Data Security Standard — a set of requirements for any business that handles credit card information, designed to reduce the risk of payment data breaches.',
  },
];

export function getTermBySlug(slug: string): GlossaryTerm | undefined {
  return GLOSSARY_TERMS.find((t) => t.slug === slug);
}

export function getCategoryBySlug(slug: string): GlossaryCategory | undefined {
  return GLOSSARY_CATEGORIES.find((c) => c.slug === slug);
}

export function getSortedTerms(): GlossaryTerm[] {
  return [...GLOSSARY_TERMS].sort((a, b) => a.term.localeCompare(b.term));
}

export function getAvailableLetters(): string[] {
  const letters = new Set(GLOSSARY_TERMS.map((t) => t.term[0].toUpperCase()));
  return Array.from(letters).sort();
}

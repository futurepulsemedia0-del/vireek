import { PhoneOff, Headset, Building2, type LucideIcon } from 'lucide-react';

export interface SwitchStep {
  title: string;
  body: string;
}

export interface SwitchFAQ {
  q: string;
  a: string;
}

export interface SwitchGuide {
  slug: string;
  /** What the business is switching away from, e.g. "Voicemail" or "A Live Answering Service" */
  fromName: string;
  icon: LucideIcon;
  category: string;
  seoTitle: string;
  seoDescription: string;
  /** Honest framing of who this guide is for and what actually changes. */
  summary: string;
  /** Things that carry over with no real disruption — reduces switching anxiety. */
  whatCarriesOver: string[];
  /** Ordered, generic migration steps. Kept process-level and honest — we don't
   *  claim to know another company's exact current UI, since that changes and
   *  we can't verify it here. Always tell the reader to confirm specifics with
   *  their current provider. */
  steps: SwitchStep[];
  timeEstimate: string;
  faq: SwitchFAQ[];
}

/**
 * IMPORTANT — keep this honest, same rule as competitors.ts:
 * Don't invent specifics about another company's cancellation process, export
 * tool, or contract terms — those change and we can't verify them from here.
 * Keep steps generic and industry-standard (call forwarding, number porting,
 * CSV export), and tell the reader to confirm exact steps with their current
 * provider. That's accurate today and stays accurate as those providers change
 * their own products.
 */
export const SWITCH_GUIDES: SwitchGuide[] = [
  {
    slug: 'voicemail',
    fromName: 'Voicemail',
    icon: PhoneOff,
    category: 'No answering system today',
    seoTitle: 'Switching From Voicemail to an AI Receptionist | Vireek',
    seoDescription:
      'Still sending missed calls to voicemail? Here is exactly what it takes to switch to Vireek instead — no contracts, no new phone number required, most businesses live in under a day.',
    summary:
      'If every call that isn\u2019t picked up in person just goes to voicemail today, this is the simplest switch there is \u2014 there\u2019s no existing vendor to untangle from, no contract to cancel, and nothing to migrate. You\u2019re just turning on an answer for calls that currently get none.',
    whatCarriesOver: [
      'Your existing business phone number \u2014 no need to give it out again or update your listings',
      'Your current phone provider, if you have one \u2014 Vireek sits on top via call forwarding, it doesn\u2019t replace your carrier',
      'How customers already reach you \u2014 nothing changes from their side except someone (Sarah) actually answers',
    ],
    steps: [
      {
        title: 'Tell Sarah about your business',
        body: 'Fill out your business profile in the Vireek dashboard \u2014 services you offer, hours, pricing basics, and how you want emergencies handled. This is what Sarah actually says on the phone, so it\u2019s worth doing properly rather than rushing it.',
      },
      {
        title: 'Connect your calendar',
        body: 'Link the calendar or scheduling tool you already use so Sarah can see real availability and book appointments directly, instead of just taking a message.',
      },
      {
        title: 'Forward your calls to Vireek',
        body: 'Set up call forwarding from your existing business number to the number Vireek provides \u2014 typically a setting in your phone carrier\u2019s app or a quick call to them. Your number never changes.',
      },
      {
        title: 'Test it yourself first',
        body: 'Call your own business number and go through a real scenario \u2014 ask about a service, try to book, mention an emergency \u2014 before you tell customers anything has changed.',
      },
      {
        title: 'Turn off "just let it ring" for good',
        body: 'Once you\u2019re comfortable with how Sarah handles calls, that\u2019s it. Every call that used to hit voicemail now gets answered, triaged, and booked instead.',
      },
    ],
    timeEstimate: 'Most businesses are live within a day \u2014 there\u2019s no existing vendor or contract to work around.',
    faq: [
      {
        q: 'Do I need a new phone number?',
        a: 'No. You keep your existing business number. Vireek receives calls via forwarding from that number, so nothing changes for your customers or your marketing.',
      },
      {
        q: 'What happens to calls Sarah can\u2019t handle?',
        a: 'You set the rules \u2014 in Call Routing & Escalation, you can have any call transferred to your own cell phone or the office line at any point, not just for emergencies.',
      },
      {
        q: 'Can I still check voicemail the old way if I want to?',
        a: 'Yes. Switching to Vireek doesn\u2019t remove your carrier\u2019s voicemail \u2014 you\u2019re just routing calls to Sarah first. Some businesses keep voicemail as a fallback for the rare case Vireek is unreachable.',
      },
    ],
  },
  {
    slug: 'answering-service',
    fromName: 'A Live Answering Service',
    icon: Headset,
    category: 'Live virtual receptionist services (Smith.ai, Ruby, PATLive, AnswerConnect, and similar)',
    seoTitle: 'Switching From a Live Answering Service to Vireek | Vireek',
    seoDescription:
      'Moving from Smith.ai, Ruby, PATLive, AnswerConnect, or a similar live answering service to Vireek? Here is what actually happens to your number, your existing contract, and your callers during the switch.',
    summary:
      'Live answering services like Smith.ai, Ruby, PATLive, and AnswerConnect all work the same basic way from a phone-system standpoint: your calls are forwarded to them. That means switching to Vireek uses the exact same mechanism \u2014 you\u2019re pointing that same forwarding at a different destination, not rebuilding your phone setup. What\u2019s different is what happens on the call itself: Sarah is trade-trained specifically for home-service calls, answers every call the same way every time, and books directly onto your calendar instead of relaying a message for someone else to call back.',
    whatCarriesOver: [
      'Your business phone number \u2014 the switch is a forwarding change, not a number change',
      'Your customers\u2019 experience of calling one number and reaching someone \u2014 that doesn\u2019t change',
      'Any CRM or scheduling tool you already use \u2014 Vireek is built to sync into what you have, not replace it',
    ],
    steps: [
      {
        title: 'Check your current contract terms',
        body: 'Before anything else, confirm your notice period and cancellation process with your current provider directly \u2014 terms vary by provider and change over time, so their own account settings or support line is the accurate source, not a guess from us.',
      },
      {
        title: 'Set up Vireek in parallel \u2014 don\u2019t cancel yet',
        body: 'Build your business profile, connect your calendar, and test Sarah on a separate number first, while your current service is still live. There\u2019s no reason to have a gap in coverage during the switch.',
      },
      {
        title: 'Run a side-by-side comparison',
        body: 'Send a batch of real (or test) calls to Sarah and compare how she handles the exact scenarios that matter most to your business \u2014 emergencies, pricing questions, booking flow \u2014 against what you\u2019re used to.',
      },
      {
        title: 'Re-point your call forwarding to Vireek',
        body: 'Once you\u2019re confident, change the forwarding destination on your business number from your current provider\u2019s number to the one Vireek gives you. This is typically the same setting you used to set up the answering service in the first place.',
      },
      {
        title: 'Cancel your old service on your terms',
        body: 'With Vireek already live and answering calls, cancel the previous service according to their process, with none of the pressure of an uncovered gap in between.',
      },
    ],
    timeEstimate: 'Most businesses run both side-by-side for a few days to a week before fully switching over \u2014 there\u2019s rarely a reason to rush it.',
    faq: [
      {
        q: 'Will I lose calls during the switch?',
        a: 'Not if you follow the parallel-setup approach above \u2014 your current service keeps answering calls right up until you re-point your forwarding, so there\u2019s no gap where calls go unanswered.',
      },
      {
        q: 'Is Vireek a live answering service too, or something different?',
        a: 'Different. Live answering services route your call to a human agent working from a script across many different businesses. Vireek is an AI voice receptionist, Sarah, trained specifically on your business and the trades \u2014 available every time, not dependent on agent availability or shift coverage.',
      },
      {
        q: 'What about the relationship or rapport my current answering service has built with regular customers?',
        a: 'That\u2019s a fair thing to weigh \u2014 a human agent who has taken repeat calls from the same customers has context Sarah won\u2019t have on day one. Sarah does build that over time through call history and customer lookups synced to your dashboard, but it\u2019s worth being honest with yourself about that trade-off before switching.',
      },
    ],
  },
  {
    slug: 'servicetitan-import',
    fromName: 'ServiceTitan',
    icon: Building2,
    category: 'Bringing your existing customer data into Vireek',
    seoTitle: 'Importing Your ServiceTitan Data Into Vireek | Vireek',
    seoDescription:
      'Already running ServiceTitan for dispatch and invoicing? Here is how to get your customer data into Vireek so Sarah recognizes returning callers from day one \u2014 without replacing ServiceTitan.',
    summary:
      'This isn\u2019t a guide to replacing ServiceTitan \u2014 most businesses that add Vireek keep running ServiceTitan for dispatch, invoicing, and reporting exactly as before. This is about getting your existing customer records into Vireek so Sarah can recognize a returning caller and pull up their history instead of starting from zero on every call.',
    whatCarriesOver: [
      'ServiceTitan stays exactly as it is \u2014 nothing about your existing setup there needs to change',
      'Your customer and job history \u2014 exported once, not re-entered by hand',
      'Ongoing new jobs Sarah books \u2014 synced back out to the tools you run day-to-day, not stuck inside Vireek',
    ],
    steps: [
      {
        title: 'Export your customer list from ServiceTitan',
        body: 'Use ServiceTitan\u2019s own customer export (typically a CSV) to pull your existing customer records. The exact menu location can move between ServiceTitan updates, so their own help docs or support are the accurate source if you can\u2019t find it.',
      },
      {
        title: 'Check the fields you actually need',
        body: 'For Sarah to recognize a caller, the useful fields are name, phone number, service address, and (if you want it) job history notes. You don\u2019t need to bring over billing or invoicing data \u2014 that stays in ServiceTitan.',
      },
      {
        title: 'Import into Vireek',
        body: 'Bring the exported file into your Vireek dashboard\u2019s customer records. If you\u2019re not sure your export is in the right shape, send it to the team \u2014 real people read these, not just a bot \u2014 and we\u2019ll tell you plainly whether it\u2019ll import cleanly.',
      },
      {
        title: 'Decide how new jobs flow back out',
        body: 'Talk to us about your specific ServiceTitan setup so new jobs Sarah books end up where your team actually works day-to-day, instead of living only inside Vireek.',
      },
    ],
    timeEstimate: 'The export-and-import itself is usually well under an hour once you have the file \u2014 most of the time goes into confirming field mapping is right, not the import itself.',
    faq: [
      {
        q: 'Does this replace ServiceTitan?',
        a: 'No. This is specifically about getting your existing customer data into Vireek so Sarah recognizes returning callers. ServiceTitan continues running dispatch, invoicing, and reporting exactly as it does today.',
      },
      {
        q: 'What if my export doesn\u2019t match the fields Vireek expects?',
        a: 'Send it to us as-is \u2014 email the team and we\u2019ll tell you honestly what will and won\u2019t import cleanly, rather than you guessing at a spreadsheet format.',
      },
      {
        q: 'Does new customer data from Sarah\u2019s calls go back into ServiceTitan automatically?',
        a: 'That depends on your specific setup \u2014 tell us how your ServiceTitan account is configured and we\u2019ll give you a straight answer on what\u2019s possible today versus what would need custom setup.',
      },
    ],
  },
];

export function getSwitchGuideBySlug(slug?: string): SwitchGuide | undefined {
  if (!slug) return undefined;
  return SWITCH_GUIDES.find((g) => g.slug === slug);
}

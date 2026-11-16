import type { DeepContentData } from './types';

export const MANIFESTO_DEEP: DeepContentData = {
  eyebrow: 'The reasoning',
  title: 'The convictions, explained: why we hold each one and what it changes in the product',
  intro:
    'A manifesto is only useful if it changes decisions. Here is what each belief means in practice, and where you can check that we are following it.',
  sections: [
    {
      id: 'every-ring',
      title: 'Why every ring is treated as a decision',
      blocks: [
        {
          kind: 'p',
          text: 'A ringing phone looks like a task to be cleared. For a home-service business it is closer to a decision: the caller is choosing whether to hire you, and the choice is usually made in the first minute. If nobody answers, the decision is made for you.',
        },
        {
          kind: 'p',
          text: 'This is why Vireek is built around answering quickly at any hour, capturing the details immediately and following up on calls that were missed. Missed-call text-back, abandoned-call recovery and quote follow-ups all exist because the first contact is often not the last chance to win the job.',
        },
      ],
    },
    {
      id: 'trade-specific',
      title: 'Why trade-specific beats general-purpose',
      blocks: [
        {
          kind: 'p',
          text: 'A general receptionist script asks for a name and a number. A trade-aware one asks what is not working, whether anyone is in danger, how long it has been happening and what equipment is involved. Those questions decide whether a call is a routine booking or an emergency, and they decide which technician and which parts the job needs.',
        },
        {
          kind: 'table',
          caption: 'What a trade-aware conversation captures',
          headers: ['Trade', 'Questions that change the outcome'],
          rows: [
            ['HVAC', 'System type, symptoms, whether it is no heat or no cooling, how long it has been out'],
            ['Plumbing', 'Whether water is actively leaking, whether it can be shut off, which fixture is affected'],
            ['Electrical', 'Whether there are burning smells, sparks or a tripped breaker that will not reset'],
            ['Roofing', 'Whether water is entering the building, recent storm activity, the roof type'],
            ['Restoration', 'Source and extent of water, fire or smoke damage, and whether the property is safe to occupy'],
          ],
        },
      ],
    },
    {
      id: 'follow-through',
      title: 'Why answering is the minimum, not the goal',
      blocks: [
        {
          kind: 'p',
          text: 'A taken message is not an outcome. The outcome is a booked appointment, a qualified lead or an emergency that reached the right person. That is why the product measures what happens after the call: outcomes, booking rates, lead scores and quality grades, not just whether the phone was picked up.',
        },
        {
          kind: 'list',
          items: [
            'Calls end with a next step wherever the business has enabled one.',
            'Summaries and outcomes are visible so you can tell a good call from a merely answered one.',
            'Quality checks sample calls for professionalism, empathy and accuracy, so problems are found by the system, not by an angry customer.',
          ],
        },
      ],
    },
    {
      id: 'honesty',
      title: 'What “say what is true” rules out',
      blocks: [
        {
          kind: 'p',
          text: 'Honesty is easy to claim and easy to quietly drop. We treat it as a list of specific things we will not do.',
        },
        {
          kind: 'list',
          items: [
            'We do not invent customer counts, testimonials or logos.',
            'We do not hide the price until checkout. Plans, included minutes and overage rates are published.',
            'We do not claim to replace emergency services.',
            'We do not claim certifications or guarantees we have not earned and cannot show.',
            'We say when something is not built yet, instead of listing it as available.',
          ],
        },
        {
          kind: 'callout',
          title: 'A useful test',
          text: 'If you ever find a claim on this site that you cannot verify, treat that as a bug and tell us. Plain wording that turns out to be wrong is a mistake to fix, not a position to defend.',
        },
      ],
    },
    {
      id: 'reliability',
      title: 'Why reliability matters more than cleverness',
      blocks: [
        {
          kind: 'p',
          text: 'A receptionist is judged at 2 a.m. on the worst night of a customer’s year, not on a demo. We prefer predictable behaviour that follows your rules over impressive but unpredictable behaviour. That shows up as configurable escalation, a knowledge base that updates what Sarah knows, and quality scoring that reviews real calls.',
        },
      ],
    },
    {
      id: 'know-limits',
      title: 'Knowing when a human is needed',
      blocks: [
        {
          kind: 'p',
          text: 'The most dangerous AI is the one that never admits it is out of its depth. Sarah is built to flag urgency, escalate to the people you named, and capture details for a callback when she should not decide something herself.',
        },
        {
          kind: 'list',
          items: [
            'Emergencies are flagged for priority handling according to your rules.',
            'Warm transfer and live escalation bring a person into the call with context on plans that include them.',
            'Anything outside what Sarah knows should become a captured message and a callback, not a guess.',
          ],
        },
      ],
    },
    {
      id: 'respect-trades',
      title: 'What “respecting the trades” means for software',
      blocks: [
        {
          kind: 'p',
          text: 'Contractors run on tight schedules and thin margins, and they will not spend a week configuring a tool. Respecting that means short setup, plain pricing, no long lock-in contracts and support that answers. It also means the interface is built for someone standing in a driveway with a phone, not for someone at a desk with an afternoon to spare.',
        },
      ],
    },
    {
      id: 'improving',
      title: 'Why we describe the product as unfinished',
      blocks: [
        {
          kind: 'p',
          text: 'Vireek is early, and saying so is part of the commitment. We would rather improve in the open, with a public changelog and roadmap, than present a finished-looking product that is not. The practical consequence for you is simple: judge Vireek on a trial with your own calls, and tell us what is missing.',
        },
      ],
    },
  ],
};

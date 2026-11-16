import type { DeepContentData } from './types';

interface CompareInput {
  name: string;
  isVoiceAICompetitor: boolean;
}

export function buildCompareDeep({ name, isVoiceAICompetitor }: CompareInput): DeepContentData {
  return {
    eyebrow: 'How to compare fairly',
    title: `Comparing Vireek and ${name}: a method you can verify yourself`,
    intro: `Vendor comparisons are easy to bias, including ours. Instead of asking you to trust our description of ${name}, this section gives you a method you can run on your own calls and a list of questions to put to any vendor.`,
    related: [
      { label: 'All comparisons', href: '/compare' },
      { label: 'Feature matrix', href: '/compare/matrix' },
      { label: 'Switching guides', href: '/switch' },
      { label: 'Pricing', href: '/pricing' },
      { label: 'ROI calculator', href: '/calculator' },
    ],
    sections: [
      {
        id: 'method',
        title: 'A fair side-by-side test',
        blocks: [
          {
            kind: 'steps',
            items: [
              { title: 'Write your real scenarios', text: 'List the calls that matter most to you: an emergency, a new booking, a reschedule, a price question and an out-of-area request.' },
              { title: 'Run the same scenarios on both', text: `Put each scenario through Vireek and through ${name}, using the same wording each time.` },
              { title: 'Score what you care about', text: 'Judge urgency recognition, information captured, the next step arranged and how the call felt to a caller.' },
              { title: 'Count the follow-up work', text: 'Note how much your team still has to do after each call.' },
              { title: 'Compare the full cost', text: 'Include usage rules, overage terms and any setup or contract commitments, using current published information from each vendor.' },
            ],
          },
        ],
      },
      {
        id: 'criteria',
        title: 'Criteria worth comparing',
        blocks: [
          {
            kind: 'table',
            caption: 'Questions to put to any tool',
            headers: ['Criterion', 'Question to ask', 'Why it matters'],
            rows: [
              ['Who handles the call', 'Does software, a person or your own team speak to the caller?', 'It decides quality, consistency and cost at night'],
              ['Trade knowledge', 'Is the setup specific to your trade or generic?', 'It shapes the questions asked'],
              ['Escalation', 'How is an urgent call recognised and who is alerted?', 'It protects your highest-value calls'],
              ['Booking', 'Can it book against your real calendar during the call?', 'A booking is the outcome, not a message'],
              ['Follow-up', 'What happens after a missed call or a quiet quote?', 'It recovers lost work'],
              ['Integrations', 'What exactly syncs with the tools you use?', 'Scope differs widely between products'],
              ['Pricing model', 'How is usage billed and what happens past the included amount?', 'It decides your real monthly cost'],
              ['Contract and exit', 'What is the term, and how do you leave?', 'It decides your flexibility'],
              ['Data and recordings', 'Where does data live and how can you export it?', 'It affects privacy and portability'],
              ['Support', 'Who answers when something breaks?', 'It matters most at the worst moment'],
            ],
          },
        ],
      },
      {
        id: 'category',
        title: `Where ${name} sits in the market`,
        blocks: isVoiceAICompetitor
          ? [
              { kind: 'p', text: `${name} is positioned in the AI voice category, so the comparison is closest to like for like. The useful differences usually lie in trade-specific setup, escalation, booking and what happens after the call, so test those directly.` },
              { kind: 'p', text: 'Because both products change, rely on each vendor’s current documentation and your own test calls rather than on any summary, including ours.' },
            ]
          : [
              { kind: 'p', text: `${name} is generally a different kind of tool from an AI receptionist, so the two are often used together instead of one replacing the other. The practical question is what each handles and what the handoff between them looks like.` },
              { kind: 'p', text: 'Check what actually syncs between the tools you use, using each vendor’s current documentation, before assuming they will work together.' },
            ],
      },
      {
        id: 'limits',
        title: 'What this page does and does not claim',
        blocks: [
          {
            kind: 'list',
            items: [
              `We describe Vireek from its own product. We do not claim to have tested ${name} on your calls.`,
              'Products and prices change, so confirm anything important with the vendor’s current information.',
              'No comparison can replace a trial on your own call types.',
              'If you find a statement here that is out of date, tell us and we will correct it.',
            ],
          },
        ],
      },
      {
        id: 'decide',
        title: 'Replace, add alongside, or stay',
        blocks: [
          {
            kind: 'list',
            items: [
              `Replace ${name} if the side-by-side test shows Vireek handles your calls better for the cost.`,
              `Add Vireek alongside ${name} if each covers a different job, such as calls versus dispatch.`,
              `Stay with ${name} if it already meets your needs and the test shows no meaningful gain.`,
            ],
          },
          { kind: 'p', text: 'The switching guides explain how to change over without a gap in coverage if you decide to move.' },
        ],
      },
    ],
    faqs: [
      { q: `Can I use ${name} and Vireek together?`, a: 'Often yes, depending on what each handles. Check how calls are routed and what information passes between them.' },
      { q: `Is this comparison based on testing ${name}?`, a: 'No. It gives you a method to test both products yourself.' },
      { q: 'What is the fairest way to decide?', a: 'Run the same real scenarios on both, compare the outcomes and the follow-up work, then compare the full cost.' },
    ],
  };
}

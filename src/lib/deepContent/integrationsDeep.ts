import type { DeepContentData } from './types';

interface IntegrationInput {
  name: string;
  category: string;
  status?: 'live' | 'coming_soon';
}

interface CategoryInfo {
  why: string;
  flow: string;
  checks: string[];
}

function categoryInfo(name: string, category: string): CategoryInfo {
  const c = category.toLowerCase();
  if (c.includes('account')) {
    return {
      why: `Accounting tools hold the financial record of the business. Connecting ${name} is meant to stop customer and job details captured by phone from being typed a second time by the office.`,
      flow: `Information moves from Vireek toward ${name}. Your accountant or bookkeeper remains responsible for categorisation, invoicing decisions and reconciliation.`,
      checks: ['Which accounting plan or edition the connection requires.', 'Who in your business is allowed to authorise access to the books.', 'Whether existing customers could be duplicated and how matching works.'],
    };
  }
  if (c.includes('calendar')) {
    return {
      why: `A calendar connection lets bookings made on the phone appear where your team already looks. Connecting ${name} is meant to avoid double-booking and manual copying.`,
      flow: `Availability is read from ${name} so real openings are offered, and confirmed bookings are written back.`,
      checks: ['Which calendar or calendars should count as your availability.', 'Whether personal events should block booking.', 'Time zone settings on the calendar and on your Vireek account.'],
    };
  }
  if (c.includes('payment')) {
    return {
      why: `Payment tools handle taking and recording money. Connecting ${name} is meant to keep payment steps in the provider built for them rather than inside a phone workflow.`,
      flow: `Money movement and card handling follow ${name}’s own terms and security model. Check the integration’s listed capabilities for what Vireek actually reads or triggers.`,
      checks: ['Which provider account will be connected and who owns it.', 'Test mode versus live mode before any real payment.', 'How refunds and disputes are handled on the provider side.'],
    };
  }
  if (c.includes('field')) {
    return {
      why: `Field-service software runs dispatch, jobs and invoices for many businesses. Connecting ${name} is meant to keep Vireek aligned with the system your team already uses.`,
      flow: `Read the capability list on this page carefully, since scope differs by connection. Anything not listed should be assumed not to sync yet.`,
      checks: ['Which parts of ${name} Vireek reads, such as price book, customers or jobs.', 'Who holds admin credentials in your business.', 'What happens in Vireek if ${name} credentials change or expire.'],
    };
  }
  if (c.includes('crm')) {
    return {
      why: `A CRM is where sales and customer history live. Connecting ${name} is meant to keep leads captured on calls available to the people who follow them up.`,
      flow: `Lead and contact information moves from Vireek toward ${name}. Check the capability list for what is created or updated.`,
      checks: ['Which records are created and which are only updated.', 'How duplicates are avoided.', 'Which team members need access in the CRM.'],
    };
  }
  if (c.includes('automation')) {
    return {
      why: `Automation tools connect many services without custom code. Connecting ${name} lets events in Vireek trigger actions elsewhere.`,
      flow: `Events leave Vireek toward ${name}, and what happens next is defined in your own automations.`,
      checks: ['Which events you actually want to trigger actions.', 'Where automations send personal data.', 'Who maintains the automations when staff change.'],
    };
  }
  return {
    why: `Connecting ${name} is meant to keep Vireek working with a tool your team already uses, instead of adding a separate place to check.`,
    flow: `Read the capability list on this page for exactly what ${name} does inside Vireek. Anything not listed should be assumed not to be included.`,
    checks: ['Which account will be connected and who owns it.', 'What data moves in each direction.', 'What happens if access is later removed.'],
  };
}

export function buildIntegrationDeep(i: IntegrationInput): DeepContentData {
  const info = categoryInfo(i.name, i.category);
  const comingSoon = i.status === 'coming_soon';
  return {
    eyebrow: `${i.name} in practice`,
    title: `Connecting ${i.name}: what to check before, during and after`,
    intro: `An integration is only as useful as its scope is clear. This guide explains how to think about the ${i.name} connection, what to prepare, how to verify it works and where to look when something looks wrong.`,
    related: [
      { label: 'All integrations', href: '/integrations' },
      { label: 'Features', href: '/features' },
      { label: 'Pricing', href: '/pricing' },
      { label: 'Platform', href: '/platform' },
    ],
    sections: [
      {
        id: 'scope',
        title: `What the ${i.name} connection covers`,
        blocks: comingSoon
          ? [
              {
                kind: 'callout',
                title: 'Coming soon',
                text: `${i.name} is listed as coming soon. No working connection exists yet, so treat this page as a statement of intent and not as a feature you can use today.`,
              },
              { kind: 'p', text: `If ${i.name} is important to your decision, ask the team directly about timing and scope before you rely on it.` },
            ]
          : [
              { kind: 'p', text: info.why },
              { kind: 'p', text: info.flow },
              {
                kind: 'callout',
                title: 'Scope rule',
                text: 'The capability list at the top of this page is the definition of scope. If something is not listed, assume it is not included, and ask before planning around it.',
              },
            ],
      },
      {
        id: 'before',
        title: 'Before you connect',
        blocks: [
          {
            kind: 'list',
            items: [
              ...info.checks.map((c) => c.replace('${name}', i.name)),
              'Which Vireek plan includes this integration, which the pricing page lists.',
              'Whether your team knows the connection is being made and who to ask about it.',
            ],
          },
        ],
      },
      {
        id: 'verify',
        title: 'Verifying it works',
        blocks: [
          {
            kind: 'steps',
            items: [
              { title: 'Connect from Settings → Integrations', text: `Follow the steps on this page and approve access in ${i.name}.` },
              { title: 'Run one controlled test', text: 'Use a test customer or a single real example, rather than a full run, and check the result in both systems.' },
              { title: 'Compare the details', text: 'Confirm names, numbers, addresses and anything else the connection should carry are correct.' },
              { title: 'Check again after a day or two', text: 'Look at real activity once it has had time to flow, and compare it against what you expect.' },
            ],
          },
        ],
      },
      {
        id: 'security',
        title: 'Keeping the connection safe',
        blocks: [
          {
            kind: 'list',
            items: [
              `Connect with an account that has only the access the integration needs, rather than a personal owner login.`,
              `Review which apps have access to ${i.name} periodically and remove ones you no longer use.`,
              'If a staff member who set up the connection leaves, reconnect it under an account the business controls.',
              'If you suspect a credential has been exposed, revoke access in the other tool and reconnect.',
            ],
          },
          {
            kind: 'p',
            text: 'For how Vireek handles account data and isolation, see the Trust Center and security pages, which are the authoritative source.',
          },
        ],
      },
      {
        id: 'troubleshooting',
        title: 'When something looks wrong',
        blocks: [
          {
            kind: 'table',
            caption: 'First checks',
            headers: ['Symptom', 'First thing to check'],
            rows: [
              ['Nothing appears after connecting', `Whether the connection shows as active in Settings → Integrations, and whether ${i.name} access was approved`],
              ['Data is missing or partial', 'The capability list, since the connection may not include that data'],
              ['It worked and then stopped', `Whether ${i.name} credentials changed or expired, and reconnect if so`],
              ['Duplicates appear', 'How existing records are matched, and whether the same person has more than one record'],
              ['Access was denied', `Whether the ${i.name} account used has the permissions needed`],
            ],
          },
          { kind: 'p', text: 'If the answer is not there, contact support with what you did and what you saw.' },
        ],
      },
    ],
    faqs: [
      { q: `Do I need ${i.name} to use Vireek?`, a: 'No. Integrations are optional, and Vireek works on its own.' },
      { q: 'Can I disconnect later?', a: `Yes. You can remove the connection in Settings → Integrations and revoke access inside ${i.name}.` },
      { q: 'How do I know what is included?', a: 'The capability list on this page defines scope. Ask the team about anything not listed.' },
    ],
  };
}

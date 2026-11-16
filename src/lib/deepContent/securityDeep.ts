import type { DeepContentData } from './types';

export const SECURITY_DEEP: DeepContentData = {
  eyebrow: 'The security model, explained',
  title: 'How the protections fit together, what you control and what to verify yourself',
  intro:
    'A security page is only useful if it is specific. This section explains each protection in plain language, separates what Vireek handles from what you control, and lists the questions worth asking any vendor, including us.',
  related: [
    { label: 'Trust Center', href: '/trust' },
    { label: 'Security portal', href: '/trust/security' },
    { label: 'Compliance status', href: '/trust/compliance' },
    { label: 'Security whitepaper', href: '/security/whitepaper' },
    { label: 'Status', href: '/status' },
  ],
  sections: [
    {
      id: 'layers',
      title: 'The protections and who is responsible for each',
      blocks: [
        {
          kind: 'table',
          caption: 'Security layers',
          headers: ['Layer', 'What it does', 'What you control'],
          rows: [
            ['Encryption in transit', 'Traffic between your browser, the dashboard and the database runs over TLS', 'Using a trusted device and network'],
            ['Encryption at rest', 'Stored data is encrypted by the infrastructure provider', 'What data you choose to enter'],
            ['Account isolation', 'Row-level security policies separate each business’s calls, leads and jobs', 'Who is invited to your account'],
            ['Role-based access', 'Owners decide who can see billing, manage the team, edit the profile or view all jobs', 'Each person’s permissions'],
            ['Configured behaviour', 'Escalation rules, greetings and business details come from you', 'What Sarah is allowed to say and do'],
          ],
        },
      ],
    },
    {
      id: 'isolation',
      title: 'What account isolation means in practice',
      blocks: [
        {
          kind: 'p',
          text: 'Many businesses share one platform, so the important question is how their data is kept apart. Row-level security attaches a rule to the data itself: a query made on behalf of one account can only return rows that belong to that account, even if the application code asks for more.',
        },
        {
          kind: 'p',
          text: 'The value of this design is that separation does not rely on every screen being written correctly. It is enforced where the data lives. No design removes all risk, but it narrows the damage a single mistake can cause.',
        },
      ],
    },
    {
      id: 'journey',
      title: 'Where call data goes',
      blocks: [
        {
          kind: 'steps',
          items: [
            { title: 'A caller dials your number', text: 'The call reaches the telephony and voice layer that answers it.' },
            { title: 'Speech is processed in real time', text: 'The conversation is converted to text so the AI can understand and respond.' },
            { title: 'The AI model produces a reply', text: 'A language model generates the response, with fallback providers available if the primary one is unavailable.' },
            { title: 'Details are saved to your account', text: 'The conversation, lead and job details are stored in the database under your account.' },
            { title: 'Your team sees it', text: 'You and the team members you permit can view the call, transcript and lead in the dashboard.' },
          ],
        },
        {
          kind: 'p',
          text: 'Each stage involves a third-party provider. The Trust Center and the sub-processor documentation list who they are and what they do, and those documents are the authoritative source.',
        },
      ],
    },
    {
      id: 'your-side',
      title: 'What you can do on your side',
      blocks: [
        {
          kind: 'list',
          items: [
            'Give each person the smallest set of permissions they need, and review that list regularly.',
            'Remove access promptly when someone leaves the business.',
            'Protect the email account tied to your login, since it is the usual route to an account takeover.',
            'Use strong, unique passwords and a password manager.',
            'Review connected integrations periodically and remove the ones you no longer use.',
            'Keep your knowledge base free of information you would not want read aloud to a caller.',
          ],
        },
      ],
    },
    {
      id: 'questions',
      title: 'Questions to ask any vendor',
      blocks: [
        {
          kind: 'p',
          text: 'These apply to Vireek and to any other tool that handles your customers’ information.',
        },
        {
          kind: 'list',
          items: [
            'Where is customer data stored, and who are the providers that process it?',
            'How is data from different customers kept apart, and where is that enforced?',
            'Who inside the vendor can access customer data, and how is that access controlled and logged?',
            'How long are recordings and transcripts kept, and how can they be deleted?',
            'What happens to data when an account is closed?',
            'How are security issues reported, and how are customers told about incidents?',
            'Which written commitments exist, such as a data processing agreement and a service level agreement?',
          ],
        },
      ],
    },
    {
      id: 'not-claimed',
      title: 'What this page does not claim',
      blocks: [
        {
          kind: 'callout',
          title: 'Plain statement',
          text: 'This page describes protections that exist in the product today. It does not announce certifications, audit results or uptime figures. Where a formal document exists, such as an agreement or a policy, that document is the source of truth, and you should ask for the current version.',
        },
        {
          kind: 'p',
          text: 'If you spot a statement that seems stronger than the evidence, tell us. We would rather correct a sentence than leave a claim we cannot back up.',
        },
      ],
    },
  ],
  faqs: [
    { q: 'Can one business see another business’s data?', a: 'The design uses row-level security policies so queries made for one account cannot return another account’s rows. If you have specific concerns, ask for the technical documentation.' },
    { q: 'Who at my business can see call recordings and transcripts?', a: 'People you have granted access to. Owners control permissions down to the individual level.' },
    { q: 'How do I report a security concern?', a: 'Use the vulnerability disclosure process linked from the Trust Center.' },
  ],
};

export const TRUST_DEEP: DeepContentData = {
  eyebrow: 'Evaluating trust',
  title: 'What is documented, what you should verify and what we ask of you',
  intro:
    'Trust is built from documents you can read and behaviour you can check. This section maps the questions buyers usually ask to the place that answers each one, and says plainly where you should verify rather than assume.',
  related: [
    { label: 'Security', href: '/security' },
    { label: 'Security portal', href: '/trust/security' },
    { label: 'Compliance status', href: '/trust/compliance' },
    { label: 'Status', href: '/status' },
    { label: 'Pricing', href: '/pricing' },
  ],
  sections: [
    {
      id: 'map',
      title: 'Which document answers which question',
      blocks: [
        {
          kind: 'table',
          caption: 'Where to look',
          headers: ['Question', 'Where it is answered'],
          rows: [
            ['What do you collect, and why?', 'The Privacy Policy'],
            ['What are the terms of use?', 'The Terms of Service'],
            ['Who processes data on your behalf?', 'The sub-processor list'],
            ['What is the data processing commitment?', 'The Data Processing Agreement'],
            ['What uptime and credits apply?', 'The Service Level Agreement'],
            ['How are callers told they are speaking with an AI?', 'The AI call disclosure and recording page'],
            ['How is AI governed in the product?', 'The Responsible AI policy'],
            ['How do I report a vulnerability?', 'The vulnerability disclosure page'],
            ['Is the service running right now?', 'The status page'],
          ],
        },
      ],
    },
    {
      id: 'ai-disclosure',
      title: 'AI, disclosure and recording',
      blocks: [
        {
          kind: 'p',
          text: 'Callers speak with an AI. Rules about telling callers that, and about recording calls, differ by region, so this is an area where you have responsibilities as well as Vireek. The disclosure page explains how callers are informed and how recordings are retained.',
        },
        {
          kind: 'list',
          items: [
            'Check the recording and consent rules that apply where your callers are located.',
            'Review the greeting so it reflects your obligations.',
            'Decide how long you want to keep recordings and transcripts, and confirm the retention behaviour.',
          ],
        },
      ],
    },
    {
      id: 'verify',
      title: 'What to verify rather than assume',
      blocks: [
        {
          kind: 'steps',
          items: [
            { title: 'Read the documents that matter to you', text: 'For most buyers that is the privacy policy, the agreement and the sub-processor list.' },
            { title: 'Test the behaviour', text: 'Call your own number, try urgent and routine scenarios, and read the summaries.' },
            { title: 'Check permissions', text: 'Create a test team member with limited access and confirm they see only what you intend.' },
            { title: 'Ask for specifics', text: 'If a question is not answered in writing, ask and note the reply.' },
          ],
        },
      ],
    },
    {
      id: 'responsibilities',
      title: 'Shared responsibilities',
      blocks: [
        {
          kind: 'list',
          items: [
            'Vireek is responsible for operating the platform and protecting the data held in it according to its documents.',
            'You are responsible for who you invite, what information you enter and the lawfulness of your own calling and messaging.',
            'Both sides should act promptly when something looks wrong, which is why reporting channels matter.',
          ],
        },
      ],
    },
  ],
  faqs: [
    { q: 'Where is the full list of providers involved?', a: 'In the sub-processor list, which is linked from the Trust Center.' },
    { q: 'Does Vireek tell callers they are talking to an AI?', a: 'The disclosure page explains how this works. Because rules vary, you should also review your own greeting.' },
    { q: 'What should an enterprise buyer request?', a: 'The current agreement, the data processing terms, the sub-processor list and the service level terms.' },
  ],
};

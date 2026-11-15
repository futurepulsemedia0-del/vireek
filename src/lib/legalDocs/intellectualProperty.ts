import { LEGAL_UPDATED, type LegalDoc } from './types';

export const intellectualPropertyDoc: LegalDoc = {
  slug: 'intellectual-property',
  path: '/intellectual-property',
  title: 'Intellectual Property Policy',
  metaTitle: 'Intellectual Property Policy | Vireek',
  description:
    'Who owns the Vireek platform, Customer data and AI output, license grants, feedback, open-source components and how to report infringement.',
  summary:
    'Vireek owns the platform. Customers own their business data. This policy explains ownership of AI outputs, feedback and third-party material.',
  updated: LEGAL_UPDATED,
  reviewStatus: 'pending-counsel',
  sections: [
    {
      id: 'vireek-ip',
      title: 'Vireek’s intellectual property',
      paragraphs: [
        'Vireek and its licensors own all rights in the platform, including the software, models and configurations we develop, voice and conversation designs, user interface, documentation, website content, trademarks, logos and trade dress. Subscribing to the service gives the Customer a limited, non-exclusive, non-transferable, revocable right to use it during the subscription for its internal business purposes under the [Terms of Service](/terms). No other rights are granted by implication.',
      ],
    },
    {
      id: 'customer-data',
      title: 'Customer content and data',
      paragraphs: [
        'Customers retain ownership of the business data they provide or that is collected for them through the service, such as customer lists, scripts, pricing, knowledge-base content, call recordings and transcripts of calls to their business. The Customer grants Vireek a limited license to host, process and use that data to provide, secure and support the service, and as described in the [Privacy Policy](/privacy) and [DPA](/dpa).',
      ],
    },
    {
      id: 'ai-output',
      title: 'AI-generated output',
      paragraphs: [
        'As between Vireek and the Customer, the Customer may use text, summaries, quotes and other output generated for it by the service for its business. Because AI output may be similar for different users and legal protection for AI-generated material varies by jurisdiction, Vireek does not promise that any output is original, copyrightable or free from third-party rights, and the Customer should review it before publishing or relying on it.',
      ],
    },
    {
      id: 'restrictions',
      title: 'Restrictions',
      paragraphs: ['Customers and visitors may not, except as the law allows regardless of this restriction:'],
      bullets: [
        'Copy, modify, sell, sublicense or create derivative works of the platform.',
        'Reverse engineer or attempt to extract source code, model weights or prompts.',
        'Scrape the site or service or use outputs to build a competing service, as set out in the [Acceptable Use Policy](/acceptable-use-policy).',
        'Remove proprietary notices or use Vireek marks except as the [Trademark Policy](/trademark-policy) allows.',
      ],
    },
    {
      id: 'feedback',
      title: 'Feedback and suggestions',
      paragraphs: [
        'If you send ideas, suggestions or feedback about the service, you grant Vireek a worldwide, perpetual, irrevocable, royalty-free license to use them without obligation or attribution. This does not transfer ownership of your confidential information or Customer data.',
      ],
    },
    {
      id: 'third-party-oss',
      title: 'Third-party and open-source components',
      paragraphs: [
        'The platform includes third-party and open-source software that remains under its own licenses. Where a license requires attribution or source availability, we comply with it. Those licenses apply to the relevant components in place of this policy to the extent they conflict.',
      ],
    },
    {
      id: 'infringement',
      title: 'Reporting infringement',
      paragraphs: [
        'We respect others’ intellectual property and expect users to do the same. To report copyright infringement, follow the process on the [DMCA & Copyright](/dmca) page. For concerns about the misuse of our trademarks, see the [Trademark Policy](/trademark-policy). We may remove content and suspend repeat infringers.',
      ],
    },
    {
      id: 'contact',
      title: 'Contact',
      paragraphs: ['Questions: [ali@vireek.com](mailto:ali@vireek.com).'],
    },
  ],
  related: [
    { label: 'DMCA & Copyright', href: '/dmca' },
    { label: 'Trademark Policy', href: '/trademark-policy' },
    { label: 'Terms of Service', href: '/terms' },
    { label: 'Acceptable Use Policy', href: '/acceptable-use-policy' },
  ],
};

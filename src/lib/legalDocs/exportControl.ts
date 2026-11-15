import { LEGAL_UPDATED, type LegalDoc } from './types';

export const exportControlDoc: LegalDoc = {
  slug: 'export-control',
  path: '/export-control',
  title: 'Export Control & Sanctions Policy',
  metaTitle: 'Export Control & Sanctions Policy | Vireek',
  description:
    'Vireek’s compliance with U.S. and international export control and economic sanctions laws, restricted countries and parties, and customer obligations.',
  summary:
    'The service may not be used by sanctioned people or in embargoed places or for prohibited end uses. This page explains the rules and what we do about them.',
  updated: LEGAL_UPDATED,
  reviewStatus: 'pending-counsel',
  sections: [
    {
      id: 'commitment',
      title: 'Our commitment',
      paragraphs: [
        'Vireek complies with export control and economic sanctions laws that apply to it, including those administered by the U.S. Department of the Treasury’s Office of Foreign Assets Control (OFAC), the U.S. Department of Commerce’s Bureau of Industry and Security (BIS) and the U.S. Department of State, and similar laws of the European Union, United Kingdom and United Nations.',
      ],
    },
    {
      id: 'restricted-parties',
      title: 'Restricted parties',
      paragraphs: ['You may not access or use the service if you or anyone acting for you:'],
      bullets: [
        'Is listed on, or owned 50% or more, directly or indirectly, by one or more persons listed on, a government restricted-party list, such as OFAC’s Specially Designated Nationals and Blocked Persons List, the BIS Entity List or the EU and UK consolidated sanctions lists.',
        'Is located in, ordinarily resident in, or organized under the laws of a country or region subject to comprehensive sanctions or embargo, which currently includes Cuba, Iran, North Korea, Syria and the Crimea, so-called Donetsk People’s Republic and Luhansk People’s Republic regions of Ukraine. This list can change as laws change.',
        'Is otherwise prohibited from receiving the service under applicable law.',
      ],
    },
    {
      id: 'prohibited-uses',
      title: 'Prohibited end uses',
      paragraphs: [
        'The service may not be used to support the development, production or use of nuclear, chemical or biological weapons, missiles or other weapons of mass destruction, military end uses or military end users where prohibited, or any activity that would breach export control or sanctions laws. See also the [Acceptable Use Policy](/acceptable-use-policy).',
      ],
    },
    {
      id: 'customer-obligations',
      title: 'Customer obligations',
      bullets: [
        'Represent that you are not a restricted party and will not use or allow the service in violation of these laws.',
        'Not upload, transmit or make available data or technology that is controlled in a way that requires a license you do not hold.',
        'Notify Vireek promptly if you become a restricted party or learn of a violation.',
      ],
    },
    {
      id: 'screening',
      title: 'Screening and enforcement',
      paragraphs: [
        'Vireek may screen customers and users against restricted-party lists, use IP-address and billing-country signals to detect access from restricted regions, and decline, suspend or terminate access without refund where required to comply with law or where we reasonably suspect a violation. We may be required to freeze funds or report to authorities.',
      ],
    },
    {
      id: 'technology',
      title: 'Technology and encryption',
      paragraphs: [
        'The service is a cloud-based software-as-a-service offering and does not require customers to download controlled software. Any client software or APIs we provide are made available subject to these laws. Customers are responsible for their own import, export and use obligations in their locations.',
      ],
    },
    {
      id: 'changes',
      title: 'Changes and contact',
      paragraphs: [
        'Sanctions and export laws change frequently, and this page may be updated accordingly. Questions or concerns: [ali@vireek.com](mailto:ali@vireek.com). Related: [Terms of Service](/terms).',
      ],
    },
  ],
  related: [
    { label: 'Terms of Service', href: '/terms' },
    { label: 'Acceptable Use Policy', href: '/acceptable-use-policy' },
    { label: 'Trust Center', href: '/trust' },
    { label: 'Legal notice (Impressum)', href: '/impressum' },
  ],
};

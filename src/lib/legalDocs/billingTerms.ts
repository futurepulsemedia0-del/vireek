import { LEGAL_UPDATED, type LegalDoc } from './types';

export const billingTermsDoc: LegalDoc = {
  slug: 'billing-terms',
  path: '/billing-terms',
  title: 'Billing & Payment Terms',
  metaTitle: 'Billing & Payment Terms | Vireek',
  description:
    'Vireek subscription billing, included minutes and overage, taxes, failed payments, plan changes, price changes, disputes and chargebacks.',
  summary:
    'How subscriptions, usage, invoices, taxes and failed payments work. Current prices are always shown on the pricing page and in your billing settings.',
  updated: LEGAL_UPDATED,
  reviewStatus: 'pending-counsel',
  sections: [
    {
      id: 'agreement',
      title: 'Relationship to other terms',
      paragraphs: [
        'These terms apply to paid Vireek plans and form part of the [Terms of Service](/terms) (or the [Master Services Agreement](/msa) where one is signed). Cancellation and refunds are covered by the [Refund & Cancellation Policy](/refund-policy). If an order form signed by both parties conflicts with these terms, the order form controls.',
      ],
    },
    {
      id: 'plans-and-prices',
      title: 'Plans and prices',
      paragraphs: [
        'The price, included usage and features of each plan are shown on the [pricing page](/pricing) and in the Customer’s billing settings at the time of purchase. All prices are shown in the currency displayed at checkout unless stated otherwise.',
      ],
    },
    {
      id: 'subscription-billing',
      title: 'Subscription billing and renewal',
      bullets: [
        'Subscriptions are billed in advance for each billing period and renew automatically for the same period until canceled.',
        'By starting a paid plan, the Customer authorizes Vireek and its payment processor to charge the payment method on file for the subscription, taxes and any usage charges.',
        'Cancellation is made from the billing settings or by email and takes effect at the end of the current billing period.',
        'Free trials, where offered, do not charge the Customer until the trial converts to a paid plan as disclosed at sign-up.',
      ],
    },
    {
      id: 'usage',
      title: 'Included usage, overage and top-ups',
      paragraphs: [
        'Plans may include a monthly allowance of call minutes or similar usage. Usage is metered by the service and visible in the dashboard. Usage above the allowance may be billed as overage or covered by a top-up purchased in the dashboard, at the rates shown in the Customer’s billing settings and on the pricing page at the time of use. Unused allowances do not carry over unless the plan says so.',
      ],
    },
    {
      id: 'plan-changes',
      title: 'Upgrades, downgrades and price changes',
      bullets: [
        'Upgrades take effect immediately and the price difference is prorated for the rest of the current billing period.',
        'Downgrades take effect at the next renewal and the difference is not refunded for the current period.',
        'Vireek may change prices with at least 30 days’ notice to active subscribers. A change applies from the next renewal after the notice period, and the Customer may cancel before then.',
      ],
    },
    {
      id: 'taxes',
      title: 'Taxes',
      paragraphs: [
        'Prices exclude sales, use, VAT, GST and similar taxes unless stated. Vireek adds taxes it is required to collect, calculated from the billing details supplied. The Customer is responsible for any taxes not collected by Vireek and must provide accurate billing details and, where relevant, a valid tax ID or exemption certificate.',
      ],
    },
    {
      id: 'payment-processing',
      title: 'Payment processing',
      paragraphs: [
        'Payments are processed by our payment processor, Stripe. Vireek does not store full card numbers. Card data is handled under the processor’s security and compliance obligations and its own terms. See [Sub-processors](/subprocessors).',
      ],
    },
    {
      id: 'failed-payments',
      title: 'Failed or late payments',
      bullets: [
        'If a payment fails, we may retry the charge and notify the account owner by email or in the dashboard.',
        'If the balance remains unpaid after notice, Vireek may restrict features, pause AI call handling or suspend the account until it is paid. Customers should keep a valid payment method on file and an escalation path for their callers.',
        'Amounts that remain overdue may be sent to collection to the extent the law allows, and the Customer is responsible for reasonable collection costs where permitted by law.',
      ],
    },
    {
      id: 'disputes',
      title: 'Billing errors, disputes and chargebacks',
      paragraphs: [
        'If a charge looks wrong, contact [ali@vireek.com](mailto:ali@vireek.com) promptly and within 60 days of the invoice, with the invoice number and a description. Verified billing errors are corrected and refunded in full. Please contact us before opening a chargeback so we can resolve the issue quickly; we may suspend an account while a payment dispute is open and may contest chargebacks that we believe are invalid.',
      ],
    },
    {
      id: 'invoices',
      title: 'Invoices and billing contact',
      paragraphs: [
        'Invoices and receipts are available in the dashboard billing section. The Customer is responsible for keeping the billing email and company details up to date.',
      ],
    },
  ],
  related: [
    { label: 'Refund & Cancellation Policy', href: '/refund-policy' },
    { label: 'Terms of Service', href: '/terms' },
    { label: 'Pricing', href: '/pricing' },
    { label: 'Service Level Agreement', href: '/sla' },
  ],
};

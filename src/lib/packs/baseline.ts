/**
 * Baseline packs: the EXISTING HVAC / plumbing / electrical operating config, expressed as pack data.
 * Derived mechanically from TRADE_PLAYBOOKS (src/lib/tradePlaybookCatalog.ts) so there is ONE source
 * of truth — improving the catalog and bumping its catalogVersion publishes a new pack version.
 * Troubleshooting trees and dispatch notes are knowledge content and stay in the playbook catalog.
 */

import { TRADE_PLAYBOOKS, type TradePlaybook } from '@/lib/tradePlaybookCatalog';
import type { FormDef, JobTypeDef, PackManifest, PricingLineDef, ReportDef } from './types';

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const key = (s: string) => {
  const k = slug(s);
  return /^[a-z]/.test(k) ? k : `x_${k}`;
};

export function playbookToPack(pb: TradePlaybook): PackManifest {
  const forms: FormDef[] = [];
  const lines: PricingLineDef[] = [];
  const jobTypes: JobTypeDef[] = pb.jobTypes.map((j) => {
    const k = key(j.key);
    forms.push({
      key: `${k}_checklist`,
      title: `${j.label} checklist`.slice(0, 120),
      kind: 'checklist',
      items: j.checklist.map((i) => ({ id: slug(i.id) || 'item', label: i.label, type: 'check' as const, ...(i.critical ? { critical: true } : {}) })),
    });
    const p = j.price;
    lines.push({
      key: k,
      label: p.serviceName.slice(0, 120),
      pricingModel: p.pricingModel,
      priceCents: p.priceCents,
      ...(p.pricingModel === 'range' ? { priceMaxCents: p.priceMaxCents ?? p.priceCents } : {}),
      estimatedCostCents: p.estimatedCostCents,
    });
    return {
      key: k,
      label: j.label,
      defaultDurationMinutes: j.benchmark.durationMinutes,
      checklistFormKey: `${k}_checklist`,
      pricingTemplateKey: `${pb.slug}_price_book`,
      ticketMinCents: j.benchmark.ticketMinCents,
      ticketMaxCents: j.benchmark.ticketMaxCents,
    };
  });
  const reports: ReportDef[] = [
    { key: 'avg_ticket_by_job_type', label: 'Average ticket by job type', metric: 'avg_ticket', groupBy: 'job_type' },
    { key: 'callback_rate_by_technician', label: 'Callback rate by technician', metric: 'callback_rate', groupBy: 'technician' },
    { key: 'first_time_fix_by_job_type', label: 'First-time fix by job type', metric: 'first_time_fix', groupBy: 'job_type' },
  ];
  return {
    schemaVersion: 1,
    id: pb.slug,
    version: `${pb.catalogVersion}.0.0`,
    name: pb.name,
    description: pb.tagline,
    jobTypes,
    forms,
    pricingTemplates: [{ key: `${pb.slug}_price_book`, label: `${pb.name} starter price book`, lines }],
    reports,
    onboardingPresets: [{
      key: `${pb.slug}_onboarding`,
      label: `${pb.name} setup`,
      steps: [
        { key: 'review_job_types', label: 'Review your job types', route: '/dashboard/jobs' },
        { key: 'review_pricing', label: 'Check starter pricing', route: '/dashboard/price-book' },
        { key: 'invite_team', label: 'Invite your technicians', route: '/dashboard/team' },
      ],
    }],
  };
}

export const BASELINE_PACKS: PackManifest[] = TRADE_PLAYBOOKS.map(playbookToPack);

import { useSyncExternalStore } from 'react';
import { getProvenance, subscribeProvenance } from '@/lib/causalDispatchApi';
import type { FactorProvenanceKind } from '@/lib/causalDispatch';

const LABEL: Record<FactorProvenanceKind, string> = {
  validated_by_randomization: 'Validated',
  observational_only: 'Observational',
  contradicted: 'Contradicted',
};
const STYLE: Record<FactorProvenanceKind, string> = {
  validated_by_randomization: 'border-success/40 text-success',
  observational_only: 'border-border text-text-secondary',
  contradicted: 'border-danger/40 text-danger',
};

/**
 * Small badge next to a factor explanation: has randomized dispatch data confirmed that this factor improves
 * first-time fix? Renders nothing until an analysis has been run, so existing screens are unchanged.
 */
export function ProvenanceBadge({ ruleType }: { ruleType: string }) {
  const all = useSyncExternalStore(subscribeProvenance, getProvenance, getProvenance);
  const ev = all?.[ruleType];
  if (!ev) return null;
  return (
    <span
      title={ev.note}
      className={`ml-1.5 inline-block rounded-full border px-1.5 py-px align-middle text-[10px] font-medium ${STYLE[ev.provenance]}`}
    >
      {LABEL[ev.provenance]}
      <span className="sr-only">. {ev.note}</span>
    </span>
  );
}

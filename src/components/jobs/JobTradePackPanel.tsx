import { useMemo, useState } from 'react';
import { ChevronDown, ClipboardCheck } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { ComplianceLogPanel } from '@/components/tradePacks/ComplianceLogPanel';
import { PoolChemistryPanel } from '@/components/tradePacks/PoolChemistryPanel';
import { useTradePacks } from '@/lib/tradePacksApi';
import { POOL_CHEMISTRY_LOG_TYPES, TRADE_PACKS, jobMatchesPack } from '@/lib/tradePacks';

/** Minimal shape so both the dashboard `Job` and the technician job brief can use the panel. */
export interface TradePackPanelJob {
  id: string;
  service_type?: string | null;
  customer_id?: string | null;
  assigned_technician_id?: string | null;
}

/**
 * Shows compliance logging for every ENABLED trade pack whose service keywords match the job.
 * Renders nothing for tenants that have not turned a pack on (packs are optional).
 */
export function JobTradePackPanel({ job }: { job: TradePackPanelJob }) {
  const { ownerId, enabled, installs } = useTradePacks();
  const [open, setOpen] = useState<string | null>(null);
  const packs = useMemo(() => TRADE_PACKS.filter((p) => enabled.has(p.key) && jobMatchesPack(p, job.service_type)), [enabled, job.service_type]);

  if (!ownerId || packs.length === 0) return null;

  return (
    <>
      {packs.map((p) => {
        const isOpen = open === p.key;
        return (
          <Card key={p.key} className="space-y-3 p-5">
            <button type="button" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : p.key)} className="focus-ring flex w-full items-center justify-between gap-2 rounded text-left">
              <span className="flex items-center gap-2 text-base font-semibold text-text-primary">
                <ClipboardCheck size={18} /> {p.name} records
              </span>
              <ChevronDown size={18} className={`transition-transform ${isOpen ? 'rotate-180' : ''}`} />
            </button>
            {isOpen && (
              <div className="space-y-6">
                {p.key === 'pool_service' && <PoolChemistryPanel pack={p} ownerId={ownerId} job={job} />}
                <ComplianceLogPanel
                  pack={p}
                  ownerId={ownerId}
                  install={installs.find((i) => i.pack_key === p.key)}
                  job={job}
                  excludeTypes={p.key === 'pool_service' ? POOL_CHEMISTRY_LOG_TYPES : undefined}
                />
              </div>
            )}
          </Card>
        );
      })}
    </>
  );
}

// Recreated: verify against original intent
// Installs a Trade Pack's starter job statuses on top of the status engine.
// Idempotent and non-destructive: the plan (starterConfigs.ts) skips anything that already exists, and each status
// is created through the same validated path as the settings screen (createStatusDefinition), one at a time so
// every new status is checked against the ones created before it.

import type { PackKey } from '@/lib/tradePacks/types';
import { planStarterStatuses } from '@/lib/tradePacks/starterConfigs';
import { createStatusDefinition } from '@/lib/statusEngineApi';
import type { StatusDefinition } from '@/lib/statusEngine';

export interface InstallStartersResult {
  added: number;
  skipped: number;
}

export async function installStarterStatuses(
  packKey: PackKey,
  existing: readonly StatusDefinition[],
  jobFieldKeys: ReadonlySet<string>,
): Promise<InstallStartersResult> {
  const plan = planStarterStatuses(packKey, existing, jobFieldKeys);
  let working: StatusDefinition[] = [...existing];
  let added = 0;
  let failed = 0;

  for (const draft of plan.create) {
    const res = await createStatusDefinition(draft, working);
    if (res.ok) {
      working = [...working, res.definition];
      added += 1;
    } else if (res.serverError) {
      // A server failure is not "skipped": stop and let the caller show the error. What was added stays added,
      // and running the install again only creates the rest.
      failed += 1;
      break;
    } else {
      // Validation rejected it (for example a label that now clashes): counted as skipped below, never overwritten.
    }
  }

  if (failed > 0) throw new Error('Could not install all starter statuses.');
  return { added, skipped: plan.skipped.length + (plan.create.length - added) };
}

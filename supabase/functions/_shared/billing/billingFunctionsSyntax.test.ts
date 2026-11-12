import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

/**
 * Regression guard: these edge functions are deployed without a type-check step, and a stray token (a duplicated
 * `} catch (err) {` once shipped in stripe-webhook) makes the whole function fail to deploy and every Stripe event 5xx.
 * transpileModule reports syntactic diagnostics only, so this needs no Deno or npm: specifier resolution.
 */
const FILES = [
  'supabase/functions/stripe-webhook/index.ts',
  'supabase/functions/manage-subscription-plan/index.ts',
  'supabase/functions/_shared/billing/planCatalog.ts',
  'supabase/functions/_shared/fraud/planLimits.ts',
];

describe('billing edge functions are syntactically valid TypeScript', () => {
  it.each(FILES)('%s', (file) => {
    const out = ts.transpileModule(readFileSync(file, 'utf8'), {
      fileName: file,
      reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    });
    const messages = (out.diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    expect(messages).toEqual([]);
  });
});

describe('stripe-webhook grandfathering', () => {
  const src = readFileSync('supabase/functions/stripe-webhook/index.ts', 'utf8');
  const updatedCase = src.slice(src.indexOf('case "customer.subscription.updated"'));

  it('syncs minutes only through minutesToSyncOnPlanSync on subscription.updated', () => {
    expect(updatedCase).toContain('minutesToSyncOnPlanSync(');
    expect(updatedCase.slice(0, updatedCase.indexOf('default:'))).not.toContain('minutes_included: minutesForPlan(');
  });
});

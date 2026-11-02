import { API_VERSION, DEFAULT_LIMIT, MAX_LIMIT } from '../../../supabase/functions/api-v1/contract';

/** Versioning, deprecation, pagination and stability policy. Header names match what api-v1 actually sends. */
export function ApiPolicies() {
  const code = 'font-mono text-xs text-text-primary';
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="rounded-2xl border border-border bg-bg-secondary/60 p-6">
        <h3 className="text-base font-semibold text-text-primary">Versioning and deprecation</h3>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-relaxed text-text-secondary">
          <li>
            The contract is versioned (currently <code className={code}>{API_VERSION}</code>) and
            every response carries <code className={code}>X-Vireek-Api-Version</code>.
          </li>
          <li>
            Not breaking: new fields, new optional parameters, new endpoints, new error codes and
            new webhook events. Ignore fields you do not recognise.
          </li>
          <li>
            Breaking changes to a Stable endpoint are announced in the changelog at least 90 days
            before they take effect.
          </li>
          <li>
            A deprecated resource sends <code className={code}>Deprecation</code> and{' '}
            <code className={code}>Sunset</code> response headers plus a{' '}
            <code className={code}>Link</code> to the migration guide. Nothing is deprecated today.
          </li>
        </ul>
      </div>
      <div className="rounded-2xl border border-border bg-bg-secondary/60 p-6">
        <h3 className="text-base font-semibold text-text-primary">
          Stability labels, pagination and filtering
        </h3>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-relaxed text-text-secondary">
          <li>
            <strong className="font-semibold text-text-primary">Stable</strong>: covered by the
            policy on the left. <strong className="font-semibold text-text-primary">Beta</strong>:
            works, but may change with a changelog note and shorter notice.
          </li>
          <li>
            Lists are newest first and cursor-paginated: <code className={code}>limit</code> ({1}–
            {MAX_LIMIT}, default {DEFAULT_LIMIT}) and <code className={code}>before</code> (pass the
            previous <code className={code}>next_before</code>).
          </li>
          <li>Filtering by field is not available yet; filter on your side after fetching.</li>
          <li>
            IP allowlists are Beta. Test keys (<code className={code}>vrk_test_…</code>) return
            synthetic data with <code className={code}>livemode: false</code>.
          </li>
        </ul>
      </div>
    </div>
  );
}

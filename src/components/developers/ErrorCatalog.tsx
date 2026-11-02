import {
  ERROR_CATALOG,
  RATE_LIMIT_PER_MINUTE,
  errorBody,
} from '../../../supabase/functions/api-v1/contract';

const EXAMPLE = JSON.stringify(
  errorBody(
    'rate_limited',
    `Rate limit exceeded (${RATE_LIMIT_PER_MINUTE} requests/minute per key). Retry shortly.`,
    '6b1f0c52-8d3e-4a7b-9f21-0e5d4c3b2a19',
  ),
  null,
  2,
);

/** Every error code the API can return. Anchors (#error-<code>) are what `doc_url` in error responses points to. */
export function ErrorCatalog() {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <h3 className="text-base font-semibold text-text-primary">Error format</h3>
          <p className="mt-2 text-sm leading-relaxed text-text-secondary">
            Every error has the same shape. Branch on{' '}
            <code className="font-mono text-xs">code</code>, never on the message text. Quote{' '}
            <code className="font-mono text-xs">request_id</code> (also sent as the{' '}
            <code className="font-mono text-xs">X-Request-Id</code> header) when you contact
            support.
          </p>
          <pre className="mt-3 overflow-x-auto rounded-xl border border-border bg-bg-primary p-3 font-mono text-xs leading-relaxed text-text-primary">
            {EXAMPLE}
          </pre>
        </div>
        <div>
          <h3 className="text-base font-semibold text-text-primary">Rate limits and headers</h3>
          <ul className="mt-2 space-y-1.5 text-sm text-text-secondary">
            <li>
              <code className="font-mono text-xs text-text-primary">X-RateLimit-Limit</code> —
              requests per minute allowed for the key ({RATE_LIMIT_PER_MINUTE}).
            </li>
            <li>
              <code className="font-mono text-xs text-text-primary">Retry-After</code> — seconds to
              wait; sent with every <code className="font-mono text-xs">429</code>.
            </li>
            <li>
              <code className="font-mono text-xs text-text-primary">X-Request-Id</code> — unique id
              of the request, on every response.
            </li>
          </ul>
          <p className="mt-3 text-sm leading-relaxed text-text-secondary">
            A remaining-requests header is not sent yet. On{' '}
            <code className="font-mono text-xs">429</code>, wait for{' '}
            <code className="font-mono text-xs">Retry-After</code> and retry with backoff.
          </p>
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Each API error with its cause and fix</caption>
          <thead className="bg-bg-tertiary/60 text-xs uppercase tracking-wide text-text-secondary">
            <tr>
              <th scope="col" className="px-4 py-2.5 font-medium">
                Code
              </th>
              <th scope="col" className="px-4 py-2.5 font-medium">
                HTTP
              </th>
              <th scope="col" className="px-4 py-2.5 font-medium">
                Cause
              </th>
              <th scope="col" className="px-4 py-2.5 font-medium">
                Fix
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {ERROR_CATALOG.map((e) => (
              <tr key={e.code} id={`error-${e.code}`} className="scroll-mt-28 target:bg-accent/5">
                <th
                  scope="row"
                  className="whitespace-nowrap px-4 py-2 text-left font-mono text-xs font-semibold text-text-primary"
                >
                  <a href={`#error-${e.code}`} className="focus-ring rounded hover:underline">
                    {e.code}
                  </a>
                </th>
                <td className="whitespace-nowrap px-4 py-2 font-mono text-xs text-text-secondary">
                  {e.status}
                </td>
                <td className="px-4 py-2 text-text-secondary">{e.cause}</td>
                <td className="px-4 py-2 text-text-secondary">{e.fix}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

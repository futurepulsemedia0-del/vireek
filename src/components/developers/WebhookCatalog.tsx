import { ShieldCheck } from 'lucide-react';
import { CodeTabs } from '@/components/developers/CodeTabs';
import {
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_DELIVERY_POLICY,
  WEBHOOK_EVENTS,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_VERIFY_SAMPLES,
  webhookSample,
} from '../../../supabase/functions/api-v1/contract';

const verifyTabs = WEBHOOK_VERIFY_SAMPLES.map(({ id, label, source }) => ({ id, label, source }));
const policy = WEBHOOK_DELIVERY_POLICY;

/**
 * Webhook reference generated from the same catalog as the OpenAPI `webhooks` block.
 * `scripts/run-samples.mjs` checks it against event-bus-dispatch and the database event list in CI.
 */
export function WebhookCatalog() {
  return (
    <div className="space-y-8 text-left">
      <div className="overflow-x-auto rounded-2xl border border-border bg-bg-secondary">
        <table className="w-full text-sm">
          <caption className="sr-only">Webhook events</caption>
          <thead>
            <tr className="border-b border-border bg-bg-tertiary/50 text-left text-xs text-text-secondary">
              <th scope="col" className="px-5 py-3 font-medium">
                Event
              </th>
              <th scope="col" className="px-5 py-3 font-medium">
                Status
              </th>
              <th scope="col" className="px-5 py-3 font-medium">
                Description
              </th>
              <th scope="col" className="px-5 py-3 font-medium">
                Payload
              </th>
            </tr>
          </thead>
          <tbody>
            {WEBHOOK_EVENTS.map((w) => (
              <tr key={w.event} className="border-b border-border/60 last:border-0">
                <td className="whitespace-nowrap px-5 py-3">
                  <code className="text-xs text-text-primary">{w.event}</code>
                </td>
                <td className="whitespace-nowrap px-5 py-3">
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
                      w.stability === 'beta'
                        ? 'bg-warning-500/10 text-warning-500'
                        : 'bg-success-500/10 text-success-500'
                    }`}
                  >
                    {w.stability === 'beta' ? 'Beta' : 'Stable'}
                  </span>
                </td>
                <td className="px-5 py-3 text-text-secondary">{w.description}</td>
                <td className="px-5 py-3 text-text-secondary">
                  {w.schema ? (
                    `${w.schema} object`
                  ) : (
                    <>
                      Full <code className="text-xs">{w.table}</code> row (schema not published yet)
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-sm leading-relaxed text-text-secondary">
        <strong className="font-semibold text-text-primary">Beta</strong> events work, but their
        payload can still change. Add endpoints and choose events under Dashboard → Event Bus; its
        Test button sends a <code className="text-xs">test.ping</code> so you can check your
        receiver.
      </p>

      <div className="space-y-3">
        <h3 className="text-base font-semibold text-text-primary">Example delivery</h3>
        <pre className="overflow-x-auto rounded-xl border border-border bg-bg-primary p-4 font-mono text-xs leading-relaxed text-text-primary">
          <code>{`POST <your-endpoint-url>
Content-Type: application/json
${WEBHOOK_SIGNATURE_HEADER}: 9f2c…e41a
${WEBHOOK_DELIVERY_HEADER}: 6b1f0c52-8d3e-4a7b-9f21-0e5d4c3b2a19

${JSON.stringify(webhookSample(WEBHOOK_EVENTS[0]), null, 2)}`}</code>
        </pre>
      </div>

      <div className="space-y-3">
        <h3 className="flex items-center gap-2 text-base font-semibold text-text-primary">
          <ShieldCheck size={18} className="text-accent" aria-hidden="true" /> Verify the signature
        </h3>
        <p className="text-sm leading-relaxed text-text-secondary">
          Each delivery is signed with your endpoint&rsquo;s{' '}
          <code className="text-xs">whsec_…</code> secret. The{' '}
          <code className="text-xs">{WEBHOOK_SIGNATURE_HEADER}</code> header is the lowercase hex
          HMAC-SHA256 of the{' '}
          <strong className="font-semibold text-text-primary">raw request body</strong>. Compute it
          over the exact bytes you received (before any JSON parsing) and compare in constant time.
          Reject the request if it does not match.
        </p>
        <CodeTabs label="Signature verification language" tabs={verifyTabs} />
        <p className="text-sm leading-relaxed text-text-secondary">
          The signature does not include a timestamp yet, so it cannot on its own stop a captured
          delivery from being replayed. De-duplicate on the <code className="text-xs">id</code>{' '}
          field (see below).
        </p>
      </div>

      <div className="space-y-3">
        <h3 className="text-base font-semibold text-text-primary">
          Delivery, retries and idempotency
        </h3>
        <ul className="list-disc space-y-1.5 pl-5 text-sm text-text-secondary">
          <li>
            Respond with {policy.success} within {policy.timeoutSeconds} seconds.
          </li>
          <li>
            Up to {policy.maxAttempts} attempts per delivery. We retry on {policy.retryOn}; we do
            not retry on {policy.noRetryOn}. Backoff: {policy.backoff}.
          </li>
          <li>
            Both attempts carry the same <code className="text-xs">id</code> and{' '}
            <code className="text-xs">{WEBHOOK_DELIVERY_HEADER}</code>. Store it and ignore repeats
            so your handler is idempotent.
          </li>
          <li>
            Failed deliveries are not queued for later redelivery, and there is no replay button
            yet. Each delivery is recorded with its final status and attempt count (Dashboard →
            Event Bus → Recent deliveries).
          </li>
          <li>
            Ordering is not guaranteed. Treat the payload as a notification and re-fetch from the
            API when you need the latest state.
          </li>
        </ul>
      </div>
    </div>
  );
}

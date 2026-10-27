/**
 * Customer portal — "People on this account". Read-only, token-gated, masked.
 * Renders nothing while loading, on error, or when there are no contacts.
 */

import { useEffect, useState } from 'react';
import { Users } from 'lucide-react';
import { ROLE_META, type ContactRole } from '@/lib/customerContacts';
import { fetchPortalContacts, type PortalContact } from '@/lib/customerContactsApi';

const roleLabel = (r: string) => (r in ROLE_META ? ROLE_META[r as ContactRole].label : r);

export function PortalContactsCard({ portalToken }: { portalToken: string }) {
  const [contacts, setContacts] = useState<PortalContact[]>([]);

  useEffect(() => {
    let live = true;
    fetchPortalContacts(portalToken)
      .then((c) => live && setContacts(c))
      .catch(() => live && setContacts([]));
    return () => {
      live = false;
    };
  }, [portalToken]);

  if (contacts.length === 0) return null;

  return (
    <section
      aria-labelledby="portal-contacts-heading"
      className="mb-4 rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark"
    >
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
          <Users className="h-5 w-5" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h2 id="portal-contacts-heading" className="text-sm font-semibold text-text-primary">
            People on this account
          </h2>
          <p className="mt-0.5 text-xs text-text-secondary">
            Who we contact for invoices, visits and urgent issues. Need a change? Send us a request and we will update it.
          </p>
        </div>
      </div>

      <ul className="mt-4 divide-y divide-border">
        {contacts.map((c) => (
          <li key={c.id} className="py-3 first:pt-0 last:pb-0">
            <p className="break-words text-sm font-medium text-text-primary">
              {c.name}
              {c.isPrimary && <span className="ml-2 rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">Primary</span>}
            </p>
            {c.title && <p className="text-xs text-text-secondary">{c.title}</p>}
            {(c.maskedEmail || c.maskedPhone) && (
              <p className="mt-0.5 break-all text-xs text-text-secondary">{[c.maskedEmail, c.maskedPhone].filter(Boolean).join(' · ')}</p>
            )}
            {(c.roles.length > 0 || c.portalRecipient) && (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {c.roles.map((r) => (
                  <span key={r} className="rounded-full border border-border bg-bg-primary px-2 py-0.5 text-xs text-text-primary">
                    {roleLabel(r)}
                  </span>
                ))}
                {c.portalRecipient && (
                  <span className="rounded-full border border-border bg-bg-primary px-2 py-0.5 text-xs text-text-primary">Gets portal link</span>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

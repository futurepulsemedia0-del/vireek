import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Loader2, Mail, MessageSquare, Pencil, Phone, Plus, Star, Trash2, TriangleAlert, UserPlus, Users } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { useToast } from '@/contexts/ToastContext';
import {
  CHANNEL_LABELS,
  CONTACT_LANGUAGES,
  CONTACT_ROLES,
  LIMITS,
  PURPOSE_META,
  ROLE_META,
  bestChannel,
  contactsForPurpose,
  describeContactError,
  draftFromContact,
  emptyDraft,
  formatPhone,
  initials,
  roleCoverage,
  validateDraft,
  type ContactChannel,
  type ContactDraft,
  type ContactLanguage,
  type ContactRole,
  type CustomerContact,
  type DraftErrors,
} from '@/lib/customerContacts';
import { createContact, deleteContact, fetchContacts, makePrimary, updateContact } from '@/lib/customerContactsApi';

interface Props {
  customerId: string;
  customerName: string;
  /** Used only for the "who gets what" preview fallback (the customer record's own email/phone). */
  customerEmail?: string | null;
  customerPhone?: string | null;
}

const selectCls =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary transition-colors focus-visible:border-accent disabled:cursor-not-allowed disabled:opacity-50';

export function CustomerContactsPanel({ customerId, customerName, customerEmail = null, customerPhone = null }: Props) {
  const { toast } = useToast();
  const [contacts, setContacts] = useState<CustomerContact[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ContactDraft>(emptyDraft());
  const [errors, setErrors] = useState<DraftErrors>({});
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<CustomerContact | null>(null);

  const requestRef = useRef(0);
  const nameRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const id = ++requestRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      const list = await fetchContacts(customerId);
      if (id !== requestRef.current) return;
      setContacts(list);
    } catch (e) {
      if (id !== requestRef.current) return;
      setLoadError(describeContactError(e));
    } finally {
      if (id === requestRef.current) setLoading(false);
    }
  }, [customerId]);

  useEffect(() => {
    void load();
    return () => {
      requestRef.current += 1;
    };
  }, [load]);

  useEffect(() => {
    if (formOpen) nameRef.current?.focus();
  }, [formOpen, editingId]);

  const coverage = useMemo(() => roleCoverage(contacts), [contacts]);
  const customerRecord = useMemo(
    () => ({ name: customerName, email: customerEmail, phone: customerPhone }),
    [customerName, customerEmail, customerPhone],
  );
  const routing = useMemo(
    () => PURPOSE_META.map((p) => ({ ...p, recipients: contactsForPurpose(contacts, p.purpose, customerRecord) })),
    [contacts, customerRecord],
  );

  const openCreate = () => {
    setEditingId(null);
    setDraft({ ...emptyDraft(), isPrimary: contacts.length === 0 });
    setErrors({});
    setFormOpen(true);
  };

  const openEdit = (c: CustomerContact) => {
    setEditingId(c.id);
    setDraft(draftFromContact(c));
    setErrors({});
    setFormOpen(true);
  };

  const closeForm = () => {
    setFormOpen(false);
    setEditingId(null);
    setErrors({});
  };

  const patch = <K extends keyof ContactDraft>(key: K, value: ContactDraft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setErrors((e) => {
      if (!e[key as keyof DraftErrors] && !e.contact) return e;
      const next = { ...e };
      delete next[key as keyof DraftErrors];
      if (key === 'email' || key === 'phone') delete next.contact;
      return next;
    });
  };

  const toggleRole = (role: ContactRole) =>
    setDraft((d) => ({ ...d, roles: d.roles.includes(role) ? d.roles.filter((r) => r !== role) : [...d.roles, role] }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    const result = validateDraft(draft, contacts, editingId);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setSaving(true);
    try {
      if (editingId) await updateContact(editingId, result.value);
      else await createContact(customerId, result.value);
      toast(editingId ? 'Contact updated.' : 'Contact added.', 'success');
      closeForm();
      await load();
    } catch (err) {
      toast(describeContactError(err), 'error');
    } finally {
      setSaving(false);
    }
  };

  const setPrimary = async (c: CustomerContact) => {
    setBusyId(c.id);
    try {
      await makePrimary(c.id);
      toast(`${c.fullName} is now the primary contact.`, 'success');
      await load();
    } catch (err) {
      toast(describeContactError(err), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const confirmRemove = async () => {
    const target = removeTarget;
    if (!target) return;
    setBusyId(target.id);
    try {
      await deleteContact(target.id);
      toast('Contact removed.', 'success');
      setRemoveTarget(null);
      await load();
    } catch (err) {
      toast(describeContactError(err), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const showForm = formOpen;
  const editingPrimary = editingId !== null && contacts.find((c) => c.id === editingId)?.isPrimary === true;

  return (
    <section
      aria-labelledby="contacts-heading"
      className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Users className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2 id="contacts-heading" className="text-base font-semibold text-text-primary">
              Contacts &amp; roles
            </h2>
            <p className="mt-0.5 text-sm text-text-secondary">
              Everyone we talk to for {customerName}. Roles decide who gets invoices, visit updates and urgent calls.
            </p>
          </div>
        </div>
        {!showForm && !loading && !loadError && contacts.length > 0 && (
          <Button size="sm" variant="secondary" onClick={openCreate}>
            <Plus className="h-4 w-4" aria-hidden="true" /> Add contact
          </Button>
        )}
      </div>

      {loading && contacts.length === 0 ? (
        <div className="mt-5 flex items-center gap-2 text-sm text-text-secondary" role="status">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading contacts…
        </div>
      ) : loadError ? (
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-bg-primary p-3 text-sm" role="alert">
          <span className="flex items-center gap-2 text-text-secondary">
            <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden="true" /> {loadError}
          </span>
          <Button size="sm" variant="secondary" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      ) : (
        <div className="mt-5 space-y-5">
          {contacts.length > 0 && (
            <ul className="flex flex-wrap gap-2" aria-label="Role coverage">
              {coverage.map((c) => (
                <li
                  key={c.role}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${
                    c.covered
                      ? 'border-border bg-bg-primary text-text-primary'
                      : 'border-dashed border-amber-500/50 bg-amber-500/10 text-text-secondary'
                  }`}
                >
                  {c.covered ? (
                    <Check className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
                  ) : (
                    <TriangleAlert className="h-3.5 w-3.5 text-amber-500" aria-hidden="true" />
                  )}
                  {ROLE_META[c.role].label}
                  <span className="text-text-secondary">{c.covered ? c.count : 'none yet'}</span>
                </li>
              ))}
            </ul>
          )}

          {contacts.length === 0 && !showForm && (
            <EmptyState
              icon={UserPlus}
              title="No contacts on this customer yet"
              description="Add the people we should reach: billing for invoices, a site contact, an emergency number, a tenant."
              action={{ label: 'Add the first contact', onClick: openCreate }}
            />
          )}

          {contacts.length > 0 && (
            <ul className="space-y-3">
              {contacts.map((c) => {
                const channel = bestChannel(c);
                const busy = busyId === c.id;
                return (
                  <li key={c.id} className="rounded-xl border border-border bg-bg-primary p-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="flex min-w-0 gap-3">
                        <span
                          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent/10 text-sm font-semibold text-accent"
                          aria-hidden="true"
                        >
                          {initials(c.fullName)}
                        </span>
                        <div className="min-w-0">
                          <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-text-primary">
                            <span className="break-words">{c.fullName}</span>
                            {c.isPrimary && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">
                                <Star className="h-3 w-3" aria-hidden="true" /> Primary
                              </span>
                            )}
                          </p>
                          {(c.jobTitle || c.siteLabel) && (
                            <p className="text-xs text-text-secondary">{[c.jobTitle, c.siteLabel].filter(Boolean).join(' · ')}</p>
                          )}
                          <div className="mt-1.5 flex flex-wrap gap-1.5">
                            {c.roles.length === 0 && <span className="text-xs text-text-secondary">No role assigned</span>}
                            {c.roles.map((r) => (
                              <span key={r} className="rounded-full border border-border bg-bg-secondary px-2 py-0.5 text-xs text-text-primary">
                                {ROLE_META[r].label}
                              </span>
                            ))}
                            {c.portalAccess && (
                              <span className="rounded-full border border-border bg-bg-secondary px-2 py-0.5 text-xs text-text-primary">Portal</span>
                            )}
                          </div>
                          <div className="mt-2 flex flex-col gap-1 text-sm text-text-secondary">
                            {c.email && (
                              <a href={`mailto:${c.email}`} className="focus-ring inline-flex items-center gap-2 break-all rounded hover:text-accent">
                                <Mail className="h-4 w-4 shrink-0" aria-hidden="true" /> {c.email}
                              </a>
                            )}
                            {c.phone && (
                              <a href={`tel:${c.phone}`} className="focus-ring inline-flex items-center gap-2 rounded hover:text-accent">
                                <Phone className="h-4 w-4 shrink-0" aria-hidden="true" /> {formatPhone(c.phone)}
                              </a>
                            )}
                            {channel && (
                              <span className="inline-flex items-center gap-2 text-xs">
                                <MessageSquare className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> Prefers {CHANNEL_LABELS[c.preferredChannel].toLowerCase()}
                              </span>
                            )}
                          </div>
                          {c.notes && <p className="mt-2 whitespace-pre-line break-words text-xs text-text-secondary">{c.notes}</p>}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2 sm:justify-end">
                        {!c.isPrimary && (
                          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void setPrimary(c)} aria-label={`Make ${c.fullName} the primary contact`}>
                            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Star className="h-4 w-4" aria-hidden="true" />}
                            Make primary
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => openEdit(c)} aria-label={`Edit ${c.fullName}`}>
                          <Pencil className="h-4 w-4" aria-hidden="true" /> Edit
                        </Button>
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRemoveTarget(c)} aria-label={`Remove ${c.fullName}`}>
                          <Trash2 className="h-4 w-4" aria-hidden="true" /> Remove
                        </Button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {showForm && (
            <form onSubmit={submit} noValidate className="space-y-4 rounded-xl border border-accent/30 bg-bg-primary p-4" aria-label={editingId ? 'Edit contact' : 'Add contact'}>
              <h3 className="text-sm font-semibold text-text-primary">{editingId ? 'Edit contact' : 'Add contact'}</h3>

              {errors.contact && (
                <p className="flex items-center gap-2 rounded-lg border border-danger bg-bg-secondary px-3 py-2 text-sm text-text-primary" role="alert">
                  <TriangleAlert className="h-4 w-4 shrink-0 text-danger" aria-hidden="true" /> {errors.contact}
                </p>
              )}

              <div className="grid gap-4 sm:grid-cols-2">
                <Input
                  ref={nameRef}
                  label="Full name"
                  required
                  autoComplete="off"
                  maxLength={LIMITS.name + 20}
                  value={draft.fullName}
                  error={errors.fullName}
                  onChange={(e) => patch('fullName', e.target.value)}
                />
                <Input
                  label="Job title"
                  autoComplete="off"
                  placeholder="Property manager"
                  value={draft.jobTitle}
                  error={errors.jobTitle}
                  onChange={(e) => patch('jobTitle', e.target.value)}
                />
                <Input
                  label="Email"
                  type="email"
                  inputMode="email"
                  autoComplete="off"
                  value={draft.email}
                  error={errors.email}
                  onChange={(e) => patch('email', e.target.value)}
                />
                <Input
                  label="Phone"
                  type="tel"
                  inputMode="tel"
                  autoComplete="off"
                  value={draft.phone}
                  error={errors.phone}
                  onChange={(e) => patch('phone', e.target.value)}
                />
              </div>

              <fieldset>
                <legend className="mb-1.5 text-sm font-medium text-text-primary">Roles</legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  {CONTACT_ROLES.map((role) => {
                    const on = draft.roles.includes(role);
                    return (
                      <button
                        key={role}
                        type="button"
                        aria-pressed={on}
                        onClick={() => toggleRole(role)}
                        className={`focus-ring flex min-h-[48px] items-start gap-3 rounded-xl border p-3 text-left transition-colors ${
                          on ? 'border-accent bg-accent/10' : 'border-border bg-bg-secondary hover:border-accent/40'
                        }`}
                      >
                        <span
                          className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border ${
                            on ? 'border-accent bg-accent text-white' : 'border-border'
                          }`}
                          aria-hidden="true"
                        >
                          {on && <Check className="h-3.5 w-3.5" />}
                        </span>
                        <span className="min-w-0">
                          <span className="block text-sm font-semibold text-text-primary">{ROLE_META[role].label}</span>
                          <span className="block text-xs text-text-secondary">{ROLE_META[role].description}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </fieldset>

              <div className="grid gap-4 sm:grid-cols-2">
                <Input
                  label="Location / unit"
                  autoComplete="off"
                  placeholder="Building B, Unit 4B"
                  helperText="Optional. Which site or unit this person covers."
                  value={draft.siteLabel}
                  error={errors.siteLabel}
                  onChange={(e) => patch('siteLabel', e.target.value)}
                />
                <div>
                  <label htmlFor="contact-channel" className="mb-1.5 block text-sm font-medium text-text-primary">
                    Preferred channel
                  </label>
                  <select
                    id="contact-channel"
                    className={selectCls}
                    value={draft.preferredChannel}
                    onChange={(e) => patch('preferredChannel', e.target.value as ContactChannel)}
                  >
                    {(Object.keys(CHANNEL_LABELS) as ContactChannel[]).map((k) => (
                      <option key={k} value={k}>
                        {CHANNEL_LABELS[k]}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="contact-language" className="mb-1.5 block text-sm font-medium text-text-primary">
                    Language
                  </label>
                  <select
                    id="contact-language"
                    className={selectCls}
                    value={draft.language}
                    onChange={(e) => patch('language', e.target.value as ContactLanguage | '')}
                  >
                    <option value="">Same as customer</option>
                    {CONTACT_LANGUAGES.map((l) => (
                      <option key={l.code} value={l.code}>
                        {l.native}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <Textarea
                label="Notes"
                rows={3}
                placeholder="Gate code, best time to call, who to ask for…"
                value={draft.notes}
                error={errors.notes}
                onChange={(e) => patch('notes', e.target.value)}
              />

              <div className="space-y-2">
                <label className="flex min-h-[44px] cursor-pointer items-start gap-3 text-sm text-text-primary">
                  <input
                    type="checkbox"
                    className="focus-ring mt-0.5 h-5 w-5 shrink-0 accent-[rgb(var(--accent-primary))]"
                    checked={draft.portalAccess}
                    onChange={(e) => patch('portalAccess', e.target.checked)}
                  />
                  <span>
                    Send the customer portal link to this person
                    <span className="block text-xs text-text-secondary">Needs an email address.</span>
                  </span>
                </label>
                {!editingPrimary && (
                  <label className="flex min-h-[44px] cursor-pointer items-start gap-3 text-sm text-text-primary">
                    <input
                      type="checkbox"
                      className="focus-ring mt-0.5 h-5 w-5 shrink-0 accent-[rgb(var(--accent-primary))]"
                      checked={draft.isPrimary}
                      onChange={(e) => patch('isPrimary', e.target.checked)}
                    />
                    <span>
                      Make this the primary contact
                      <span className="block text-xs text-text-secondary">Used when no one has the role we are looking for.</span>
                    </span>
                  </label>
                )}
              </div>

              <div className="flex flex-wrap justify-end gap-2 pt-1">
                <Button type="button" variant="ghost" size="sm" onClick={closeForm} disabled={saving}>
                  Cancel
                </Button>
                <Button type="submit" size="sm" disabled={saving}>
                  {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                  {editingId ? 'Save changes' : 'Add contact'}
                </Button>
              </div>
            </form>
          )}

          {contacts.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Who gets what</h3>
              <dl className="mt-2 divide-y divide-border rounded-xl border border-border bg-bg-primary">
                {routing.map((row) => (
                  <div key={row.purpose} className="flex flex-col gap-1 px-3 py-2.5 text-sm sm:flex-row sm:items-baseline sm:gap-4">
                    <dt className="shrink-0 text-text-secondary sm:w-48">{row.label}</dt>
                    <dd className="min-w-0 text-text-primary">
                      {row.recipients.length === 0 ? (
                        <span className="text-amber-600 dark:text-amber-400">No one reachable</span>
                      ) : (
                        row.recipients.map((r, i) => (
                          <span key={`${r.contactId ?? 'customer'}-${i}`}>
                            {i > 0 && ', '}
                            {r.name}
                            {r.isFallback && <span className="text-text-secondary"> (fallback)</span>}
                          </span>
                        ))
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={!!removeTarget}
        title="Remove this contact?"
        description={
          removeTarget?.isPrimary && contacts.length > 1
            ? `${removeTarget.fullName} is the primary contact. The oldest remaining contact becomes primary.`
            : `${removeTarget?.fullName ?? 'This contact'} will no longer receive messages for ${customerName}.`
        }
        confirmLabel="Yes, remove them"
        onConfirm={confirmRemove}
        onCancel={() => setRemoveTarget(null)}
      />
    </section>
  );
}

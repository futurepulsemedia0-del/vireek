// src/pages/WallboardSettingsPage.tsx
//
// /dashboard/wallboard: owner-only management of dispatch TV links.
// The raw link is shown ONCE at creation (only its hash is stored), so a lost
// link is handled by revoking and creating a new one.

import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, ExternalLink, Lock, Monitor, Pencil, Plus, Trash2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { SkeletonCardList, FadeIn } from '@/components/Skeleton';
import { getPublicOrigin } from '@/lib/appOrigin';
import {
  DEFAULT_ROTATION_SECONDS,
  MAX_ROTATION_SECONDS,
  MIN_ROTATION_SECONDS,
  PANEL_KEYS,
  PANEL_LABELS,
  buildWallboardUrl,
  formatAge,
  type WallboardPanelKey,
} from '@/lib/wallboard';
import {
  WallboardError,
  createWallboard,
  listWallboards,
  revokeWallboard,
  updateWallboard,
  validateWallboardInput,
  type WallboardRow,
} from '@/lib/wallboardApi';

const ONLINE_WITHIN_MS = 3 * 60_000;

interface FormState {
  name: string;
  rotation: string;
  panels: WallboardPanelKey[];
  goal: string;
}

const EMPTY_FORM: FormState = { name: '', rotation: String(DEFAULT_ROTATION_SECONDS), panels: [...PANEL_KEYS], goal: '' };

const errText = (e: unknown) => (e instanceof WallboardError ? e.message : 'Something went wrong. Please try again.');

export function WallboardSettingsPage() {
  const { isOwner } = useAuth();
  const { toast } = useToast();

  const [rows, setRows] = useState<WallboardRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<WallboardRow | null>(null);
  const [fresh, setFresh] = useState<{ name: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      setRows(await listWallboards());
      setNowMs(Date.now());
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isOwner) {
      setLoading(false);
      return;
    }
    void load();
    const id = window.setInterval(() => void load(), 60_000); // keeps "online / last seen" honest
    return () => window.clearInterval(id);
  }, [isOwner, load]);

  const openCreate = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormError(undefined);
    setFormOpen(true);
  };

  const openEdit = (r: WallboardRow) => {
    setEditingId(r.id);
    setForm({ name: r.name, rotation: String(r.rotationSeconds), panels: r.panels, goal: r.revenueGoalOverride === null ? '' : String(r.revenueGoalOverride) });
    setFormError(undefined);
    setFormOpen(true);
  };

  const togglePanel = (key: WallboardPanelKey) =>
    setForm((f) => ({
      ...f,
      panels: f.panels.includes(key) ? f.panels.filter((p) => p !== key) : PANEL_KEYS.filter((p) => p === key || f.panels.includes(p)),
    }));

  const submit = async () => {
    const rotation = Number(form.rotation);
    const goalTrim = form.goal.trim();
    const goal = goalTrim === '' ? null : Number(goalTrim);
    if (!Number.isFinite(rotation) || rotation < MIN_ROTATION_SECONDS || rotation > MAX_ROTATION_SECONDS) {
      setFormError(`Rotation must be between ${MIN_ROTATION_SECONDS} and ${MAX_ROTATION_SECONDS} seconds.`);
      return;
    }
    if (goal !== null && !Number.isFinite(goal)) {
      setFormError('Enter the monthly goal as a number, or leave it empty.');
      return;
    }
    const input = { name: form.name, rotationSeconds: rotation, panels: form.panels, revenueGoalOverride: goal };
    const invalid = validateWallboardInput(input);
    if (invalid) {
      setFormError(invalid);
      return;
    }
    setSaving(true);
    setFormError(undefined);
    try {
      if (editingId) {
        await updateWallboard(editingId, input);
        toast('Display updated. Screens pick it up within a minute.', 'success');
      } else {
        const created = await createWallboard(input);
        setFresh({ name: input.name.trim(), url: buildWallboardUrl(getPublicOrigin(), created.token) });
        setCopied(false);
      }
      setFormOpen(false);
      await load();
    } catch (e) {
      setFormError(errText(e));
    } finally {
      setSaving(false);
    }
  };

  const confirmRevoke = async () => {
    if (!revokeTarget) return;
    try {
      await revokeWallboard(revokeTarget.id);
      toast(`"${revokeTarget.name}" was revoked. Its screen will show a "link unavailable" message.`, 'success');
      setRevokeTarget(null);
      await load();
    } catch (e) {
      toast(errText(e), 'error');
      setRevokeTarget(null);
    }
  };

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      toast('Could not copy automatically. Select the link and copy it manually.', 'error');
    }
  };

  if (!isOwner) {
    return (
      <DashboardLayout activeLabel="Wallboard (TV)">
        <EmptyState icon={Lock} title="Owner access only" description="Only the account owner can create or revoke dispatch TV links, because a link gives anyone who holds it a live view of operations." />
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel="Wallboard (TV)">
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-text-primary">Dispatch wallboard (TV)</h1>
            <p className="mt-1 max-w-2xl text-sm text-text-secondary">
              A full-screen, auto-rotating display for the dispatch office: today&apos;s jobs, technicians, open emergencies, missed calls and revenue vs goal. Open the link on any TV browser, no login needed.
            </p>
          </div>
          {!formOpen && (
            <Button onClick={openCreate}>
              <Plus size={16} aria-hidden="true" /> New display
            </Button>
          )}
        </header>

        {fresh && (
          <FadeIn>
            <section className="rounded-xl border border-success-500/30 bg-success-500/10 p-4" aria-live="polite">
              <p className="text-sm font-semibold text-text-primary">&quot;{fresh.name}&quot; is ready. Copy its link now.</p>
              <p className="mt-1 text-xs text-text-secondary">For security the link is shown only once. If you lose it, revoke this display and create a new one.</p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <input readOnly value={fresh.url} onFocus={(e) => e.currentTarget.select()} aria-label="Wallboard link" className="focus-ring min-w-0 flex-1 rounded-xl border border-border bg-bg-primary px-3 py-2 text-xs text-text-primary" />
                <Button variant="secondary" onClick={() => void copy(fresh.url)}>
                  {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />} {copied ? 'Copied' : 'Copy'}
                </Button>
                <a href={fresh.url} target="_blank" rel="noopener noreferrer" className="focus-ring inline-flex items-center gap-1.5 rounded-xl border border-border bg-bg-secondary px-3 py-2 text-sm font-medium text-text-primary hover:border-accent/40">
                  <ExternalLink size={16} aria-hidden="true" /> Open
                </a>
                <Button variant="ghost" onClick={() => setFresh(null)}>
                  Done
                </Button>
              </div>
            </section>
          </FadeIn>
        )}

        {formOpen && (
          <section className="rounded-xl border border-border bg-bg-secondary p-5" aria-label={editingId ? 'Edit display' : 'New display'}>
            <h2 className="text-lg font-semibold text-text-primary">{editingId ? 'Edit display' : 'New display'}</h2>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Input label="Name" value={form.name} maxLength={60} placeholder="Front office TV" onChange={(e) => setForm({ ...form, name: e.target.value })} required />
              <Input
                label="Seconds per panel"
                type="number"
                inputMode="numeric"
                min={MIN_ROTATION_SECONDS}
                max={MAX_ROTATION_SECONDS}
                value={form.rotation}
                onChange={(e) => setForm({ ...form, rotation: e.target.value })}
                helperText={`${MIN_ROTATION_SECONDS} to ${MAX_ROTATION_SECONDS}. Critical emergencies stay on screen 50% longer.`}
              />
              <Input
                label="Monthly revenue goal (optional)"
                type="number"
                inputMode="decimal"
                min={0}
                value={form.goal}
                placeholder="Use the goal from Executive Reports"
                onChange={(e) => setForm({ ...form, goal: e.target.value })}
                helperText="Leave empty to use the goal already set in Executive Reports."
              />
            </div>
            <fieldset className="mt-4">
              <legend className="mb-2 text-sm font-medium text-text-primary">Panels to rotate through</legend>
              <div className="flex flex-wrap gap-2">
                {PANEL_KEYS.map((key) => {
                  const on = form.panels.includes(key);
                  return (
                    <label key={key} className={`focus-within:ring-2 focus-within:ring-accent/40 inline-flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm ${on ? 'border-accent/50 bg-accent/10 text-text-primary' : 'border-border bg-bg-primary text-text-secondary'}`}>
                      <input type="checkbox" className="h-4 w-4 accent-[rgb(var(--accent-primary))]" checked={on} onChange={() => togglePanel(key)} />
                      {PANEL_LABELS[key]}
                    </label>
                  );
                })}
              </div>
              <p className="mt-2 text-xs text-text-secondary">The open-emergencies panel is skipped while there are none; the top numbers on the screen always show the count.</p>
            </fieldset>
            {formError && (
              <p role="alert" className="mt-3 text-sm text-danger">
                {formError}
              </p>
            )}
            <div className="mt-5 flex gap-2">
              <Button onClick={() => void submit()} disabled={saving}>
                {saving ? 'Saving…' : editingId ? 'Save changes' : 'Create display'}
              </Button>
              <Button variant="ghost" onClick={() => setFormOpen(false)} disabled={saving}>
                Cancel
              </Button>
            </div>
          </section>
        )}

        {loading ? (
          <SkeletonCardList count={2} rows={2} />
        ) : loadError ? (
          <EmptyState icon={Monitor} title="Couldn't load your displays" description="Check your connection and try again." action={{ label: 'Retry', onClick: () => { setLoading(true); void load(); } }} />
        ) : rows.length === 0 ? (
          <EmptyState icon={Monitor} title="No displays yet" description="Create one, open the link on the office TV, and press F for fullscreen." action={{ label: 'New display', onClick: openCreate }} />
        ) : (
          <ul className="space-y-3">
            {rows.map((r) => {
              const online = r.lastSeenAt !== null && nowMs - Date.parse(r.lastSeenAt) < ONLINE_WITHIN_MS;
              return (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-bg-secondary p-4">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-base font-semibold text-text-primary">
                      <Monitor size={18} aria-hidden="true" className="text-text-secondary" />
                      <span className="truncate">{r.name}</span>
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${online ? 'bg-success-500/15 text-success-500' : 'bg-bg-tertiary text-text-secondary'}`}>{online ? 'Online' : 'Offline'}</span>
                    </p>
                    <p className="mt-1 text-xs text-text-secondary">
                      {r.panels.map((p) => PANEL_LABELS[p]).join(' · ')} · {r.rotationSeconds}s per panel · last seen {r.lastSeenAt ? formatAge(r.lastSeenAt, nowMs) : 'never'}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="secondary" onClick={() => openEdit(r)} aria-label={`Edit ${r.name}`}>
                      <Pencil size={16} aria-hidden="true" /> Edit
                    </Button>
                    <Button variant="ghost" onClick={() => setRevokeTarget(r)} aria-label={`Revoke ${r.name}`}>
                      <Trash2 size={16} aria-hidden="true" /> Revoke
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={revokeTarget !== null}
        title="Revoke this display?"
        description="The TV using this link will stop showing data immediately. This cannot be undone; you would create a new display and link."
        confirmLabel="Yes, revoke it"
        onConfirm={confirmRevoke}
        onCancel={() => setRevokeTarget(null)}
      />
    </DashboardLayout>
  );
}

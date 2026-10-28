import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AlertTriangle, ChevronDown, ChevronRight, Clock, Crown, Network, RotateCcw, Search, Users, X } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { Skeleton, SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { useEscapeToClose, useFocusTrap } from '@/lib/a11y/focusTrap';
import {
  NOTE_MAX,
  ROLE_LABELS,
  TITLE_MAX,
  buildOrgTree,
  eligibleManagers,
  initials,
  managerChain,
  orgErrorMessage,
  periodLabel,
  positionChanged,
  searchOrg,
  summarizeOrg,
  tenureLabel,
  validatePositionForm,
  type AccessRole,
  type HistoryEntry,
  type OrgMember,
  type OrgNode,
  type OrgOverview,
  type PositionForm,
} from '@/lib/orgChart';
import { getOrgHistory, getOrgOverview, setOrgPosition } from '@/lib/orgChartApi';

// ============================================================
// SHARED BITS
// ============================================================

type ToastFn = (message: string, type?: 'success' | 'error' | 'info') => void;

const panelClass = 'rounded-2xl border border-border bg-bg-secondary p-4';
const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary transition-colors focus-visible:border-accent disabled:cursor-not-allowed disabled:opacity-50';

/** Above this many people the chart opens with everything below the first level collapsed. */
const LARGE_TEAM = 60;

const ROLE_TONES: Record<AccessRole, string> = {
  owner: 'bg-accent/10 text-accent',
  admin: 'bg-blue-500/10 text-blue-500',
  technician: 'bg-warning/10 text-warning',
  member: 'bg-bg-tertiary text-text-secondary',
};

function Pill({ text, className }: { text: string; className: string }) {
  return <span className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${className}`}>{text}</span>;
}

function Avatar({ name, url, size = 40 }: { name: string; url?: string | null; size?: number }) {
  const [broken, setBroken] = useState(false);
  const style = { width: size, height: size };
  if (url && !broken) {
    return <img src={url} alt="" style={style} className="shrink-0 rounded-full object-cover" onError={() => setBroken(true)} />;
  }
  return (
    <span
      style={style}
      aria-hidden="true"
      className="flex shrink-0 items-center justify-center rounded-full bg-accent/10 text-sm font-bold text-accent"
    >
      {initials(name)}
    </span>
  );
}

function StatCard({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className={panelClass}>
      <p className="text-xl font-bold text-text-primary">{value}</p>
      <p className="mt-0.5 text-xs text-text-secondary">{label}</p>
      {hint && <p className="mt-0.5 text-[11px] text-text-secondary/80">{hint}</p>}
    </div>
  );
}

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const ref = useFocusTrap(true);
  useEscapeToClose(true, onClose);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden="true" />
      <div
        ref={ref}
        className="relative max-h-[92vh] w-full overflow-y-auto rounded-t-2xl border border-border bg-bg-primary p-5 pb-8 shadow-xl sm:max-w-xl sm:rounded-2xl sm:pb-5"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 className="min-w-0 truncate text-lg font-bold text-text-primary">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="focus-ring flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-text-secondary hover:bg-bg-tertiary"
          >
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ============================================================
// PAGE
// ============================================================

export function OrgChartPage() {
  const { toast } = useToast();
  return (
    <DashboardLayout activeLabel="Org Chart">
      <div className="mx-auto max-w-6xl px-0 py-2 sm:px-2">
        <OrgChart toast={toast} />
      </div>
    </DashboardLayout>
  );
}

// ============================================================
// DATA + CHART
// ============================================================

function OrgChart({ toast }: { toast: ToastFn }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('member');

  const [overview, setOverview] = useState<OrgOverview | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const loadSeq = useRef(0);
  const initialised = useRef(false);
  // Kept in a ref so a new toast function identity can never re-trigger loading.
  const toastRef = useRef(toast);
  toastRef.current = toast;

  const load = useCallback(async (quiet = false) => {
    const seq = ++loadSeq.current;
    if (quiet) setRefreshing(true);
    else setPhase('loading');
    try {
      const next = await getOrgOverview();
      if (seq !== loadSeq.current) return;
      if (!initialised.current) {
        initialised.current = true;
        if (next.members.length > LARGE_TEAM) {
          const { roots } = buildOrgTree(next.members);
          const fold = new Set<string>();
          const walk = (n: OrgNode) => {
            if (n.depth >= 1 && n.children.length > 0) fold.add(n.member.id);
            n.children.forEach(walk);
          };
          roots.forEach(walk);
          setCollapsed(fold);
        }
      }
      setOverview(next);
      setPhase('ready');
    } catch (err) {
      if (seq !== loadSeq.current) return;
      if (quiet) toastRef.current(orgErrorMessage(err, "Couldn't refresh the org chart."), 'error');
      else setPhase('error');
    } finally {
      if (seq === loadSeq.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const members = useMemo(() => overview?.members ?? [], [overview]);
  const { roots, maxDepth } = useMemo(() => buildOrgTree(members), [members]);
  const summary = useMemo(() => summarizeOrg(members, roots, maxDepth), [members, roots, maxDepth]);
  const search = useMemo(() => searchOrg(members, query), [members, query]);
  const searching = query.trim() !== '';
  const selected = useMemo(() => members.find((m) => m.id === selectedId) ?? null, [members, selectedId]);

  const open = useCallback(
    (id: string) => {
      const next = new URLSearchParams(params);
      next.set('member', id);
      setParams(next);
    },
    [params, setParams],
  );
  const close = useCallback(() => {
    const next = new URLSearchParams(params);
    next.delete('member');
    setParams(next, { replace: true });
  }, [params, setParams]);

  const toggle = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const collapseAll = () => {
    const fold = new Set<string>();
    const walk = (n: OrgNode) => {
      if (n.children.length > 0) fold.add(n.member.id);
      n.children.forEach(walk);
    };
    roots.forEach(walk);
    setCollapsed(fold);
  };

  if (phase === 'loading') {
    return (
      <div className="space-y-4" aria-busy="true" role="status" aria-label="Loading org chart">
        <Skeleton className="h-10 w-64" />
        <SkeletonStatGrid count={4} />
        <SkeletonCardList count={4} />
      </div>
    );
  }
  if (phase === 'error' || !overview) {
    return (
      <EmptyStateError
        icon={AlertTriangle}
        title="We couldn't load the org chart"
        description="Check your connection and try again."
        onRetry={() => void load()}
      />
    );
  }

  const canManage = overview.can_manage;
  const hasResults = search.visible.size > 0;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-text-primary">Org chart</h1>
          <p className="mt-1 text-sm text-text-secondary">
            Who reports to whom, and how everyone&apos;s role has changed over time.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => void load(true)} disabled={refreshing}>
            <RotateCcw size={16} className={refreshing ? 'animate-spin' : ''} /> {refreshing ? 'Refreshing…' : 'Refresh'}
          </Button>
          {canManage && (
            <Button variant="secondary" size="sm" onClick={() => navigate('/dashboard/team')}>
              <Users size={16} /> Manage team
            </Button>
          )}
        </div>
      </header>

      <section aria-label="Team structure" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="People" value={summary.headcount} hint={summary.pending > 0 ? `+ ${summary.pending} pending invite${summary.pending === 1 ? '' : 's'}` : undefined} />
        <StatCard label="Managers" value={summary.managers} />
        <StatCard label="Levels" value={summary.levels} />
        <StatCard label="Widest span of control" value={summary.widestSpan} />
      </section>

      {members.length === 0 ? (
        <EmptyState
          icon={Network}
          title="Your org chart starts with you"
          description="Invite your team, then set who reports to whom. The chart and everyone's role history build themselves."
          action={canManage ? { label: 'Invite team members', onClick: () => navigate('/dashboard/team') } : undefined}
        />
      ) : (
        <>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <Input
                icon={Search}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by name, title or role"
                aria-label="Search the org chart"
                autoComplete="off"
              />
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => setCollapsed(new Set())} disabled={searching}>
                Expand all
              </Button>
              <Button variant="ghost" size="sm" onClick={collapseAll} disabled={searching}>
                Collapse all
              </Button>
            </div>
          </div>

          {canManage && !searching && (
            <p className="text-xs text-text-secondary">Select a person to change their title or who they report to.</p>
          )}

          <div className={`${panelClass} overflow-hidden`}>
            <div className="flex items-center gap-3 rounded-xl border border-accent/30 bg-accent/5 p-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent/10 text-accent" aria-hidden="true">
                <Crown size={18} />
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-text-primary">{overview.owner.name}</p>
                <p className="truncate text-xs text-text-secondary">
                  Owner{overview.owner.company && overview.owner.company !== overview.owner.name ? ` · ${overview.owner.company}` : ''}
                </p>
              </div>
            </div>

            {hasResults ? (
              <ul aria-label="Reporting lines" className="mt-3 space-y-2 border-l border-border pl-3 sm:pl-5">
                {roots.map((node) => (
                  <TreeItem
                    key={node.member.id}
                    node={node}
                    collapsed={collapsed}
                    onToggle={toggle}
                    onOpen={open}
                    visible={search.visible}
                    matches={search.matches}
                    searching={searching}
                    selectedId={selected?.id ?? null}
                  />
                ))}
              </ul>
            ) : (
              <EmptyState
                className="mt-3"
                icon={Search}
                title="No one matches your search"
                description="Try a different name, title or role."
                action={{ label: 'Clear search', onClick: () => setQuery('') }}
              />
            )}
          </div>
        </>
      )}

      {selected && (
        <MemberSheet
          key={selected.id}
          member={selected}
          overview={overview}
          onClose={close}
          onOpen={open}
          onSaved={() => load(true)}
          toast={toast}
        />
      )}
    </div>
  );
}

// ============================================================
// TREE
// ============================================================

function TreeItem({
  node,
  collapsed,
  onToggle,
  onOpen,
  visible,
  matches,
  searching,
  selectedId,
}: {
  node: OrgNode;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
  visible: Set<string>;
  matches: Set<string>;
  searching: boolean;
  selectedId: string | null;
}) {
  const { member } = node;
  if (!visible.has(member.id)) return null;

  const children = node.children.filter((c) => visible.has(c.member.id));
  const hasChildren = children.length > 0;
  const expanded = hasChildren && (searching || !collapsed.has(member.id));
  const groupId = `org-children-${member.id}`;
  const isMatch = searching && matches.has(member.id);
  const isSelected = selectedId === member.id;

  return (
    <li>
      <div className="flex items-center gap-1">
        {hasChildren ? (
          <button
            type="button"
            onClick={() => onToggle(member.id)}
            disabled={searching}
            aria-expanded={expanded}
            aria-controls={groupId}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${member.name}'s team`}
            className="focus-ring flex h-11 w-9 shrink-0 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-tertiary disabled:opacity-40"
          >
            {expanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
          </button>
        ) : (
          <span className="w-9 shrink-0" aria-hidden="true" />
        )}

        <button
          type="button"
          onClick={() => onOpen(member.id)}
          aria-label={`${member.name}${member.title ? `, ${member.title}` : ''}. Open details`}
          className={`focus-ring flex min-h-[56px] min-w-0 flex-1 items-center gap-3 rounded-xl border bg-bg-primary p-2.5 text-left transition-colors hover:border-accent/50 ${
            isSelected ? 'border-accent' : isMatch ? 'border-accent/60 bg-accent/5' : 'border-border'
          }`}
        >
          <Avatar name={member.name} url={member.photo_url} />
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-semibold text-text-primary">{member.name}</span>
              {member.is_me && <Pill text="You" className="bg-accent/10 text-accent" />}
              {member.invite_status === 'pending' && <Pill text="Pending" className="bg-warning/10 text-warning" />}
            </span>
            <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="truncate text-xs text-text-secondary">{member.title ?? ROLE_LABELS[member.access_role]}</span>
              {member.title && <Pill text={ROLE_LABELS[member.access_role]} className={ROLE_TONES[member.access_role]} />}
            </span>
          </span>
          {node.reportCount > 0 && (
            <span className="hidden shrink-0 items-center gap-1 text-xs text-text-secondary sm:flex" title="Total people below this person">
              <Users size={14} aria-hidden="true" /> {node.reportCount}
            </span>
          )}
        </button>
      </div>

      {expanded && (
        <ul id={groupId} className="ml-3 mt-2 space-y-2 border-l border-border pl-3 sm:ml-5 sm:pl-5">
          {children.map((child) => (
            <TreeItem
              key={child.member.id}
              node={child}
              collapsed={collapsed}
              onToggle={onToggle}
              onOpen={onOpen}
              visible={visible}
              matches={matches}
              searching={searching}
              selectedId={selectedId}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

// ============================================================
// MEMBER SHEET (details, edit, role history)
// ============================================================

function MemberSheet({
  member,
  overview,
  onClose,
  onOpen,
  onSaved,
  toast,
}: {
  member: OrgMember;
  overview: OrgOverview;
  onClose: () => void;
  onOpen: (id: string) => void;
  onSaved: () => Promise<void>;
  toast: ToastFn;
}) {
  const { members, can_manage: canManage } = overview;
  const chain = useMemo(() => managerChain(members, member.id), [members, member.id]);
  const directReports = useMemo(() => members.filter((m) => m.reports_to_id === member.id), [members, member.id]);
  const managerOptions = useMemo(() => eligibleManagers(members, member.id), [members, member.id]);
  const canSeeHistory = canManage || member.is_me;

  const [form, setForm] = useState<PositionForm>({ title: member.title ?? '', reportsTo: member.reports_to_id ?? '', note: '' });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [historyPhase, setHistoryPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const historySeq = useRef(0);

  const loadHistory = useCallback(async () => {
    const seq = ++historySeq.current;
    setHistoryPhase('loading');
    try {
      const rows = await getOrgHistory(member.id);
      if (seq !== historySeq.current) return;
      setHistory(rows);
      setHistoryPhase('ready');
    } catch {
      if (seq === historySeq.current) setHistoryPhase('error');
    }
  }, [member.id]);

  useEffect(() => {
    if (canSeeHistory) void loadHistory();
  }, [canSeeHistory, loadHistory]);

  const errors = validatePositionForm(form);
  const dirty = positionChanged(member, form);
  const ownerLabel = overview.owner.name;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving || !dirty || Object.keys(errors).length > 0) return;
    setSaving(true);
    setFormError(null);
    try {
      const changed = await setOrgPosition({
        memberId: member.id,
        title: form.title.trim(),
        reportsTo: form.reportsTo || null,
        note: form.note.trim(),
      });
      toast(changed ? `${member.name}'s position was updated.` : 'Nothing to change.', changed ? 'success' : 'info');
      setForm((f) => ({ ...f, title: f.title.trim(), note: '' }));
      await Promise.all([onSaved(), loadHistory()]);
    } catch (err) {
      setFormError(orgErrorMessage(err, "Couldn't save the change. Please try again."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet title={member.name} onClose={onClose}>
      <div className="space-y-5">
        <div className="flex items-center gap-3">
          <Avatar name={member.name} url={member.photo_url} size={56} />
          <div className="min-w-0">
            <p className="truncate text-base font-semibold text-text-primary">{member.title ?? 'No title set'}</p>
            {member.email && <p className="truncate text-xs text-text-secondary">{member.email}</p>}
            <div className="mt-1 flex flex-wrap gap-1.5">
              <Pill text={ROLE_LABELS[member.access_role]} className={ROLE_TONES[member.access_role]} />
              {member.invite_status === 'pending' && <Pill text="Invite pending" className="bg-warning/10 text-warning" />}
              {member.is_me && <Pill text="You" className="bg-accent/10 text-accent" />}
            </div>
          </div>
        </div>

        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <div className={panelClass}>
            <dt className="text-xs text-text-secondary">Reports to</dt>
            <dd className="mt-0.5 font-medium text-text-primary">{chain[0]?.name ?? ownerLabel}</dd>
          </div>
          <div className={panelClass}>
            <dt className="text-xs text-text-secondary">In this position</dt>
            <dd className="mt-0.5 font-medium text-text-primary">{tenureLabel(member.since) || '—'}</dd>
          </div>
          <div className={`${panelClass} sm:col-span-2`}>
            <dt className="text-xs text-text-secondary">Reporting line</dt>
            <dd className="mt-0.5 break-words font-medium text-text-primary">
              {[ownerLabel, ...[...chain].reverse().map((m) => m.name), member.name].join(' › ')}
            </dd>
          </div>
        </dl>

        {directReports.length > 0 && (
          <section aria-label="Direct reports">
            <h3 className="mb-2 text-sm font-semibold text-text-primary">Direct reports ({directReports.length})</h3>
            <ul className="space-y-1.5">
              {directReports.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => onOpen(r.id)}
                    className="focus-ring flex min-h-[48px] w-full items-center gap-3 rounded-xl border border-border bg-bg-secondary p-2 text-left hover:border-accent/50"
                  >
                    <Avatar name={r.name} url={r.photo_url} size={32} />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-text-primary">{r.name}</span>
                      <span className="block truncate text-xs text-text-secondary">{r.title ?? ROLE_LABELS[r.access_role]}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {canManage && (
          <form onSubmit={save} className="space-y-3" aria-label="Edit position" noValidate>
            <h3 className="text-sm font-semibold text-text-primary">Edit position</h3>
            <Input
              label="Job title"
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              maxLength={TITLE_MAX + 20}
              placeholder="e.g. Lead Technician"
              error={errors.title}
              helperText={errors.title ? undefined : 'Shown on the org chart. Leave blank to show the access role.'}
            />
            <div>
              <label htmlFor="org-reports-to" className="mb-1.5 block text-sm font-medium text-text-primary">
                Reports to
              </label>
              <select
                id="org-reports-to"
                className={selectClass}
                value={form.reportsTo}
                onChange={(e) => setForm((f) => ({ ...f, reportsTo: e.target.value }))}
              >
                <option value="">{ownerLabel} (Owner)</option>
                {managerOptions.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                    {m.title ? ` — ${m.title}` : ''}
                  </option>
                ))}
              </select>
              <p className="mt-1.5 text-xs text-text-secondary">People who report to {member.name} can&apos;t be chosen, so loops are impossible.</p>
            </div>
            <Textarea
              label="Note (optional)"
              rows={2}
              value={form.note}
              onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
              maxLength={NOTE_MAX + 40}
              placeholder="Why this changed, e.g. Promoted after certification"
              error={errors.note}
              helperText={errors.note ? undefined : 'Saved with the role history.'}
            />
            {formError && (
              <p role="alert" className="text-sm text-danger">
                {formError}
              </p>
            )}
            <Button type="submit" className="w-full sm:w-auto" disabled={saving || !dirty || Object.keys(errors).length > 0}>
              {saving ? 'Saving…' : 'Save changes'}
            </Button>
          </form>
        )}

        <section aria-label="Role history">
          <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-text-primary">
            <Clock size={16} aria-hidden="true" /> Role history
          </h3>
          {!canSeeHistory ? (
            <p className="text-sm text-text-secondary">Role history is visible to managers and to the person themselves.</p>
          ) : historyPhase === 'loading' && !history ? (
            <div className="space-y-2" aria-busy="true" role="status" aria-label="Loading role history">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : historyPhase === 'error' ? (
            <EmptyStateError
              icon={AlertTriangle}
              title="We couldn't load the history"
              description="Check your connection and try again."
              onRetry={() => void loadHistory()}
            />
          ) : !history || history.length === 0 ? (
            <EmptyState icon={Clock} title="No history yet" description="Changes to this person's title, access role or manager will appear here." />
          ) : (
            <ol className="space-y-3 border-l border-border pl-4">
              {history.map((h, i) => (
                <li key={h.id} className="relative">
                  <span
                    aria-hidden="true"
                    className={`absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full ${i === 0 ? 'bg-accent' : 'bg-border'}`}
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-semibold text-text-primary">{h.title ?? ROLE_LABELS[h.access_role]}</p>
                    <Pill text={ROLE_LABELS[h.access_role]} className={ROLE_TONES[h.access_role]} />
                    {i === 0 && !h.ended_at && <Pill text="Current" className="bg-success/10 text-success" />}
                  </div>
                  <p className="text-xs text-text-secondary">
                    {h.reports_to_name ? `Reports to ${h.reports_to_name}` : `Reports to ${ownerLabel}`} · {periodLabel(h.started_at, h.ended_at)}
                  </p>
                  {h.note && <p className="mt-1 text-sm text-text-primary">{h.note}</p>}
                  {h.changed_by_name && <p className="mt-0.5 text-[11px] text-text-secondary">Changed by {h.changed_by_name}</p>}
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </Sheet>
  );
}

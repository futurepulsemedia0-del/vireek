import { useCallback, useEffect, useState } from 'react';
import { Header } from '@/components/Header';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input, Textarea } from '@/components/ui/Input';
import { useToast } from '@/contexts/ToastContext';
import { supabase } from '@/lib/supabase';
import { SCREENSHOT_BUCKET, staffRpc } from '@/lib/feedback/api';

type Tab = 'inbox' | 'themes' | 'trends' | 'top' | 'help' | 'followups' | 'publish';
const TABS: { id: Tab; label: string }[] = [
  { id: 'inbox', label: 'Inbox' }, { id: 'themes', label: 'Themes' }, { id: 'trends', label: 'Trends' }, { id: 'top', label: 'Top requests' },
  { id: 'help', label: 'Help gaps' }, { id: 'followups', label: 'Follow-ups' }, { id: 'publish', label: 'You asked, we built' },
];
const STATUSES = ['received', 'triaged', 'planned', 'in_progress', 'shipped', 'closed', 'declined'];

type Row = Record<string, unknown> & { id: string };
const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));

function useStaffData<T>(fn: string, args: Record<string, unknown>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try { setError(null); setData(await staffRpc<T>(fn, args)); }
    catch (e) { setError((e as { code?: string })?.code === '42501' ? 'Staff access required.' : 'Could not load this view.'); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { void reload(); }, [reload]);
  return { data, error, reload };
}

function Err({ msg }: { msg: string | null }) { return msg ? <p role="alert" className="text-sm text-danger">{msg}</p> : null; }

function Inbox() {
  const { toast } = useToast();
  const [status, setStatus] = useState('');
  const { data, error, reload } = useStaffData<{ total: number; items: Row[] }>('staff_feedback_inbox', { p_status: status || null, p_limit: 50 }, [status]);
  const [shot, setShot] = useState<string | null>(null);
  const act = async (id: string, patch: Record<string, unknown>) => {
    try { await staffRpc('staff_feedback_update', { p_id: id, ...patch }); await reload(); } catch { toast('Update failed.', 'error'); }
  };
  const viewShot = async (path: string) => {
    const { data: u } = await supabase.storage.from(SCREENSHOT_BUCKET).createSignedUrl(path, 120);
    setShot(u?.signedUrl ?? null);
  };
  return (
    <div className="space-y-3">
      <label className="text-sm text-text-primary">Status <select value={status} onChange={(e) => setStatus(e.target.value)} className="focus-ring ms-2 rounded-lg border border-border bg-bg-primary px-2 py-1">
        <option value="">All</option>{STATUSES.map((x) => <option key={x} value={x}>{x}</option>)}</select></label>
      <Err msg={error} />
      {data && <p className="text-sm text-text-secondary">{data.total} total</p>}
      {shot && <div><img src={shot} alt="Customer screenshot" className="max-h-72 rounded border border-border" /><button className="text-xs underline" onClick={() => setShot(null)}>Hide</button></div>}
      <ul className="space-y-2">
        {data?.items.map((f) => (
          <li key={f.id}><Card className="!p-3 text-sm">
            <div className="flex flex-wrap gap-2 text-xs text-text-secondary">
              <b className="font-mono text-text-primary">{s(f.tracking_code)}</b><span>{s(f.category)}</span><span>{s(f.plan)}/{s(f.role)}</span>
              <span>{f.anonymous ? 'anonymous' : `account ${s(f.account_owner_id).slice(0, 8)}`}</span>{f.contact_ok ? <span>may contact</span> : null}
              {f.theme_id ? <span>theme ({s(f.theme_source)})</span> : null}
            </div>
            <p className="mt-1 whitespace-pre-wrap text-text-primary">{s(f.message)}</p>
            <p className="mt-1 text-xs text-text-secondary">{JSON.stringify(f.context)}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <select aria-label={`Status for ${s(f.tracking_code)}`} value={s(f.status)} onChange={(e) => void act(f.id, { p_status: e.target.value })} className="focus-ring rounded-lg border border-border bg-bg-primary px-2 py-1">
                {STATUSES.map((x) => <option key={x} value={x}>{x}</option>)}</select>
              {f.screenshot_path ? <Button size="sm" variant="secondary" onClick={() => void viewShot(s(f.screenshot_path))}>Screenshot</Button> : null}
              <RoadmapLink onSave={(rid) => void act(f.id, { p_roadmap_item_id: rid })} />
            </div>
          </Card></li>
        ))}
      </ul>
    </div>
  );
}

function RoadmapLink({ onSave }: { onSave: (id: string) => void }) {
  const [v, setV] = useState('');
  const ok = /^[0-9a-f-]{36}$/i.test(v);
  return (
    <span className="flex items-center gap-1">
      <input aria-label="Roadmap item id" placeholder="roadmap item id" value={v} onChange={(e) => setV(e.target.value.trim())} className="focus-ring w-48 rounded-lg border border-border bg-bg-primary px-2 py-1 text-xs" />
      <Button size="sm" variant="secondary" disabled={!ok} onClick={() => onSave(v)}>Link</Button>
    </span>
  );
}

function Themes() {
  const { toast } = useToast();
  const { data, error, reload } = useStaffData<Row[]>('staff_themes_list', {}, []);
  const [busy, setBusy] = useState(false);
  const cluster = async () => {
    setBusy(true);
    try {
      const { data: r, error: e } = await supabase.functions.invoke('feedback-cluster', { body: {} });
      if (e) throw e;
      toast(`AI proposed ${(r as { created?: number })?.created ?? 0} theme(s) — review them below.`, 'success');
      await reload();
    } catch { toast('Clustering is unavailable (is the AI provider configured?).', 'error'); }
    setBusy(false);
  };
  const review = async (id: string, decision: 'confirm' | 'reject') => {
    try { await staffRpc('staff_theme_review', { p_theme_id: id, p_decision: decision }); await reload(); } catch { toast('Review failed.', 'error'); }
  };
  return (
    <div className="space-y-3">
      <Button onClick={() => void cluster()} loading={busy} loadingLabel="Clustering…">Suggest themes with AI</Button>
      <p className="text-xs text-text-secondary">AI only proposes. Nothing counts as a confirmed theme until a person confirms it.</p>
      <Err msg={error} />
      <ul className="space-y-2">
        {data?.map((t) => (
          <li key={t.id}><Card className="!p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2"><b className="text-text-primary">{s(t.title)}</b>
              <span className="text-xs text-text-secondary">{s(t.status)} · {s(t.source)} · {s(t.count)} item(s)</span></div>
            <p className="text-text-secondary">{s(t.summary)}</p>
            {t.status === 'suggested' && <div className="mt-2 flex gap-2"><Button size="sm" onClick={() => void review(t.id, 'confirm')}>Confirm</Button>
              <Button size="sm" variant="secondary" onClick={() => void review(t.id, 'reject')}>Reject</Button></div>}
          </Card></li>
        ))}
      </ul>
    </div>
  );
}

function Json({ fn, args = {}, title }: { fn: string; args?: Record<string, unknown>; title: string }) {
  const { data, error } = useStaffData<unknown>(fn, args, []);
  return <Card className="!p-3"><h3 className="mb-2 text-sm font-semibold text-text-primary">{title}</h3><Err msg={error} />
    <pre className="max-h-[28rem] overflow-auto text-xs text-text-secondary">{data ? JSON.stringify(data, null, 2) : 'Loading…'}</pre></Card>;
}

function Followups() {
  const { toast } = useToast();
  const { data, error, reload } = useStaffData<Row[]>('staff_followups_list', { p_status: 'open' }, []);
  const [body, setBody] = useState<Record<string, string>>({});
  const upd = async (id: string, patch: Record<string, unknown>) => {
    try {
      const r = await staffRpc<{ ok: boolean; reason?: string }>('staff_followup_update', { p_id: id, ...patch });
      if (!r.ok) toast(r.reason === 'no_contact_consent' ? 'This person did not agree to be emailed.' : 'Update failed.', 'error');
      await reload();
    } catch { toast('Update failed.', 'error'); }
  };
  return (
    <div className="space-y-2"><Err msg={error} />
      {data?.map((f) => (
        <Card key={f.id} className="!p-3 text-sm">
          <b className="text-text-primary">{s(f.reason)}</b> <span className="text-xs text-text-secondary">{s(f.severity)} · due {s(f.due_at).slice(0, 10)} · email {s(f.email_status)}</span>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => void upd(f.id, { p_status: 'done' })}>Mark done</Button>
            <Button size="sm" variant="secondary" onClick={() => void upd(f.id, { p_status: 'dismissed' })}>Dismiss</Button>
          </div>
          {f.contact_ok ? (
            <div className="mt-2 space-y-1">
              <Textarea label="Follow-up email" rows={3} maxLength={1500} value={body[f.id] ?? ''} onChange={(e) => setBody({ ...body, [f.id]: e.target.value })} />
              <Button size="sm" disabled={!(body[f.id] ?? '').trim()} onClick={() => void upd(f.id, { p_email_body: body[f.id] })}>Queue email</Button>
            </div>
          ) : <p className="mt-1 text-xs text-text-secondary">No email consent — follow up in-app or by phone.</p>}
        </Card>
      ))}
    </div>
  );
}

function Publish() {
  const { toast } = useToast();
  const [title, setTitle] = useState(''); const [text, setText] = useState(''); const [href, setHref] = useState(''); const [rid, setRid] = useState('');
  const send = async () => {
    try {
      const r = await staffRpc<{ ok: boolean; notified?: number; reason?: string }>('staff_publish_you_asked', {
        p_title: title, p_body: text, p_href: href || null, p_roadmap_item_id: rid || null, p_feedback_ids: [],
      });
      if (r.ok) { toast(`Published. ${r.notified ?? 0} people notified.`, 'success'); setTitle(''); setText(''); setHref(''); setRid(''); }
      else toast('Check the title, text and link (must start with /).', 'error');
    } catch { toast('Publish failed.', 'error'); }
  };
  return (
    <Card className="space-y-3 !p-4">
      <Input label="Title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
      <Textarea label="What we built" rows={3} value={text} onChange={(e) => setText(e.target.value)} maxLength={600} />
      <Input label="App link (optional, starts with /)" value={href} onChange={(e) => setHref(e.target.value)} />
      <Input label="Roadmap item id (optional) — notifies everyone whose feedback is linked to it" value={rid} onChange={(e) => setRid(e.target.value.trim())} />
      <Button onClick={() => void send()} disabled={title.trim().length < 3 || text.trim().length < 3}>Publish</Button>
    </Card>
  );
}

export function StaffFeedbackPage() {
  const [tab, setTab] = useState<Tab>('inbox');
  return (
    <div className="min-h-screen bg-bg-primary">
      <Header />
      <main id="main-content" className="mx-auto max-w-5xl space-y-4 px-4 py-8">
        <h1 className="text-2xl font-bold text-text-primary">Feedback operations</h1>
        <div role="tablist" aria-label="Feedback views" className="flex flex-wrap gap-2">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
              className={`focus-ring rounded-full border px-3 py-1.5 text-sm font-medium ${tab === t.id ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary'}`}>{t.label}</button>
          ))}
        </div>
        <div role="tabpanel">
          {tab === 'inbox' && <Inbox />}
          {tab === 'themes' && <Themes />}
          {tab === 'trends' && <Json fn="staff_feedback_trends" args={{ p_days: 90 }} title="Last 90 days by plan and role" />}
          {tab === 'top' && <Json fn="staff_feedback_top_requests" args={{ p_limit: 20 }} title="Roadmap votes + linked feedback" />}
          {tab === 'help' && <Json fn="staff_help_gap_report" args={{ p_days: 30 }} title="Searches with no result and weak articles" />}
          {tab === 'followups' && <Followups />}
          {tab === 'publish' && <Publish />}
        </div>
      </main>
    </div>
  );
}

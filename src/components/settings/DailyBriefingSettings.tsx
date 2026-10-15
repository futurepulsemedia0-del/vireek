import { useCallback, useEffect, useMemo, useState } from 'react';
import { Sunrise } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { supabase } from '@/lib/supabase';
import {
  allowedSections,
  canSeeBilling,
  SECTION_TITLES,
  type BriefingPrefs,
  type BriefingRole,
} from '@/lib/dailyBriefing';
import {
  browserTimezone,
  enrollMember,
  fetchPrefRecords,
  savePrefs,
  syncBrowserTimezone,
  type PrefRecord,
} from '@/lib/dailyBriefingApi';

interface TeamRow {
  id: string;
  member_name: string | null;
  member_email: string;
  role: BriefingRole;
}

const hourLabel = (h: number) => `${h % 12 === 0 ? 12 : h % 12}:00 ${h < 12 ? 'AM' : 'PM'}`;

function timezones(current: string): string[] {
  let list: string[] = [];
  try {
    list =
      (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.(
        'timeZone',
      ) ?? [];
  } catch {
    list = [];
  }
  return Array.from(new Set([current, browserTimezone(), ...list]));
}

function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${checked ? 'bg-accent' : 'bg-bg-tertiary'}`}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${checked ? 'translate-x-[22px]' : 'translate-x-0.5'}`}
      />
    </button>
  );
}

function PrefsEditor({
  record,
  role,
  canBilling,
  busy,
  onSave,
}: {
  record: PrefRecord;
  role: BriefingRole;
  canBilling: boolean;
  busy: boolean;
  onSave: (patch: Partial<BriefingPrefs>) => void;
}) {
  const p = record.prefs;
  const sections = allowedSections(role, canBilling);
  const selected = p.sections ?? sections;
  const zones = useMemo(() => timezones(p.timezone), [p.timezone]);

  const toggleSection = (key: (typeof sections)[number], on: boolean) => {
    const next = on ? [...selected, key] : selected.filter((k) => k !== key);
    if (next.length === 0) return; // at least one section
    onSave({ sections: next.length === sections.length ? null : next });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-text-primary">Send me a daily briefing</p>
          <p className="text-xs text-text-secondary">
            Yesterday’s results, today’s risks and 3 recommended actions.
          </p>
        </div>
        <Switch
          label="Daily briefing"
          checked={p.enabled}
          disabled={busy}
          onChange={(v) => onSave({ enabled: v })}
        />
      </div>

      {p.enabled && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-text-secondary">
              Delivery time
              <select
                className="mt-1 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
                value={p.sendHour}
                disabled={busy}
                onChange={(e) => onSave({ sendHour: Number(e.target.value) })}
              >
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {hourLabel(h)}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-text-secondary">
              Timezone
              <select
                className="mt-1 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
                value={p.timezone}
                disabled={busy}
                onChange={(e) => onSave({ timezone: e.target.value })}
              >
                {zones.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <fieldset>
            <legend className="text-xs font-medium text-text-secondary">Deliver via</legend>
            <div className="mt-2 flex flex-wrap gap-4">
              {(
                [
                  ['inApp', 'Dashboard card'],
                  ['push', 'Push notification'],
                  ['email', 'Email'],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="flex items-center gap-2 text-sm text-text-primary">
                  <input
                    type="checkbox"
                    checked={p.channels[key]}
                    disabled={busy}
                    onChange={(e) =>
                      onSave({ channels: { ...p.channels, [key]: e.target.checked } })
                    }
                  />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend className="text-xs font-medium text-text-secondary">Include</legend>
            <div className="mt-2 flex flex-wrap gap-4">
              {sections.map((key) => (
                <label key={key} className="flex items-center gap-2 text-sm text-text-primary">
                  <input
                    type="checkbox"
                    checked={selected.includes(key)}
                    disabled={busy}
                    onChange={(e) => toggleSection(key, e.target.checked)}
                  />
                  {SECTION_TITLES[key]}
                </label>
              ))}
            </div>
          </fieldset>
        </>
      )}
    </div>
  );
}

export function DailyBriefingSettings() {
  const { profile, isOwner, teamMember, permissions } = useAuth();
  const { toast } = useToast();
  const [records, setRecords] = useState<PrefRecord[] | null>(null);
  const [team, setTeam] = useState<TeamRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const role: BriefingRole = isOwner ? 'owner' : (teamMember?.role ?? 'member');
  const canBilling = canSeeBilling(role, permissions as { can_view_billing?: boolean } | null);
  const myRecord = records?.find((r) =>
    isOwner ? r.teamMemberId === null : r.teamMemberId === teamMember?.id,
  );

  const load = useCallback(async () => {
    try {
      const rows = await fetchPrefRecords();
      setRecords(rows);
      const mine = rows.find((r) =>
        isOwner ? r.teamMemberId === null : r.teamMemberId === teamMember?.id,
      );
      void syncBrowserTimezone(rows, mine?.id);
      if (isOwner) {
        const { data } = await supabase
          .from('team_members')
          .select('id,member_name,member_email,role')
          .eq('invite_status', 'active');
        setTeam((data as TeamRow[] | null) ?? []);
      }
    } catch {
      setFailed(true);
    }
  }, [isOwner, teamMember?.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (id: string, patch: Partial<BriefingPrefs>) => {
    setBusy(id);
    try {
      await savePrefs(id, patch);
      await load();
    } catch {
      toast('Could not save that setting. Please try again.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const enroll = async (memberId: string) => {
    if (!profile) return;
    setBusy(memberId);
    try {
      await enrollMember(profile.id, memberId);
      await load();
    } catch {
      toast('Could not add that team member.', 'error');
    } finally {
      setBusy(null);
    }
  };

  if (failed) return null;

  return (
    <section
      id="daily-briefing"
      className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark"
    >
      <div className="flex items-center gap-2.5">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-bg-tertiary text-text-secondary">
          <Sunrise size={16} />
        </span>
        <div>
          <h2 className="text-base font-semibold text-text-primary">Daily briefing</h2>
          <p className="text-sm text-text-secondary">
            What changed, what’s at risk today, and what to do about it.
          </p>
        </div>
      </div>

      <div className="mt-5">
        {!records ? (
          <div className="h-20 animate-pulse rounded-xl bg-bg-tertiary" aria-hidden="true" />
        ) : myRecord ? (
          <PrefsEditor
            record={myRecord}
            role={role}
            canBilling={canBilling}
            busy={busy === myRecord.id}
            onSave={(patch) => save(myRecord.id, patch)}
          />
        ) : (
          <p className="text-sm text-text-secondary">
            {isOwner
              ? 'Your briefing will be set up automatically — check back in a moment.'
              : 'Ask your account owner to add you to the daily briefing.'}
          </p>
        )}
      </div>

      {isOwner && team.length > 0 && (
        <div className="mt-6 border-t border-border/60 pt-4">
          <h3 className="text-sm font-semibold text-text-primary">Team briefings</h3>
          <p className="text-xs text-text-secondary">
            Each person gets content for their role; billing details only if they have billing
            access.
          </p>
          <ul className="mt-3 divide-y divide-border/60">
            {team.map((m) => {
              const rec = records?.find((r) => r.teamMemberId === m.id);
              return (
                <li key={m.id} className="flex items-center justify-between gap-3 py-3">
                  <div>
                    <p className="text-sm text-text-primary">{m.member_name || m.member_email}</p>
                    <p className="text-xs capitalize text-text-secondary">{m.role}</p>
                  </div>
                  {rec ? (
                    <Switch
                      label={`Briefing for ${m.member_name || m.member_email}`}
                      checked={rec.prefs.enabled}
                      disabled={busy === rec.id}
                      onChange={(v) => save(rec.id, { enabled: v })}
                    />
                  ) : (
                    <button
                      type="button"
                      disabled={busy === m.id}
                      onClick={() => enroll(m.id)}
                      className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-bg-tertiary disabled:opacity-50"
                    >
                      Turn on
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}

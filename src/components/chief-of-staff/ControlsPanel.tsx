// Recreated: verify against original intent
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { OctagonAlert, Play } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Panel } from '@/components/ui/Panel';
import { Select } from '@/components/ui/Select';
import { useToast } from '@/contexts/ToastContext';
import { useChiefT } from '@/i18n/chiefOfStaffNamespace';
import {
  setAgentDial,
  setAutonomyByRisk,
  setKillSwitch,
  type AgentDial,
  type AutonomyMode,
  type CosSettings,
  type RiskLevel,
} from '@/lib/chiefOfStaff';

interface Props {
  settings: CosSettings;
  dials: AgentDial[];
  pendingApprovals: number;
  onChanged: () => void;
}

const RISKS: RiskLevel[] = ['low', 'medium', 'high', 'critical'];
const MODES: AutonomyMode[] = ['suggest', 'approve', 'auto'];
const MAX_CAP = 10_000;

/** '' (empty box) means "no cap". Anything else must be a whole number in range, otherwise invalid. */
function parseCap(raw: string): { ok: true; value: number | null } | { ok: false } {
  const v = raw.trim();
  if (v === '') return { ok: true, value: null };
  if (!/^\d+$/.test(v)) return { ok: false };
  const n = Number(v);
  return n >= 0 && n <= MAX_CAP ? { ok: true, value: n } : { ok: false };
}

export function ControlsPanel({ settings, dials, pendingApprovals, onChanged }: Props) {
  const { t } = useChiefT();
  const canManage = settings.can_manage;

  return (
    <Panel title={t('controls.title')} aria-label={t('controls.title')}>
      <div className="space-y-6">
        {!canManage && <p className="text-xs text-text-secondary">{t('controls.noManage')}</p>}

        <KillSwitch settings={settings} canManage={canManage} onChanged={onChanged} />
        <AutonomyByRisk settings={settings} canManage={canManage} onChanged={onChanged} />
        {dials.length > 0 && <AgentDials dials={dials} canManage={canManage} onChanged={onChanged} />}

        {pendingApprovals > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-bg-tertiary/60 px-3 py-2">
            <p className="text-sm text-text-primary">{t('controls.queue', { count: pendingApprovals })}</p>
            <Link to="/dashboard/agent-actions" className="focus-ring rounded text-sm font-medium text-accent hover:underline">
              {t('controls.openQueue')}
            </Link>
          </div>
        )}
      </div>
    </Panel>
  );
}

function useSaving() {
  const [saving, setSaving] = useState(false);
  const lock = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const run = async (fn: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setSaving(true);
    try {
      await fn();
    } finally {
      lock.current = false;
      if (alive.current) setSaving(false);
    }
  };
  return { saving, run };
}

function KillSwitch({ settings, canManage, onChanged }: { settings: CosSettings; canManage: boolean; onChanged: () => void }) {
  const { t } = useChiefT();
  const { toast } = useToast();
  const { saving, run } = useSaving();
  const [reason, setReason] = useState('');
  const active = settings.kill_switch_active;

  const flip = () =>
    run(async () => {
      try {
        await setKillSwitch(!active, active ? undefined : reason.trim() || undefined);
        setReason('');
        onChanged();
      } catch {
        toast(t('controls.killSwitch.failed'), 'error');
      }
    });

  return (
    <section aria-labelledby="cos-kill-switch">
      <h3 id="cos-kill-switch" className="text-sm font-semibold text-text-primary">{t('controls.killSwitch.label')}</h3>
      <p className="mt-0.5 text-xs text-text-secondary">{t('controls.killSwitch.hint')}</p>
      {!active && canManage && (
        <div className="mt-3">
          <Input label={t('controls.killSwitch.reasonLabel')} value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
        </div>
      )}
      <div className="mt-3">
        <Button
          size="sm"
          variant={active ? 'secondary' : 'danger'}
          onClick={() => void flip()}
          loading={saving}
          disabled={!canManage}
          disabledReason={!canManage ? t('controls.noManage') : undefined}
        >
          {active ? <Play size={14} aria-hidden="true" /> : <OctagonAlert size={14} aria-hidden="true" />}
          {active ? t('controls.killSwitch.turnOff') : t('controls.killSwitch.turnOn')}
        </Button>
      </div>
    </section>
  );
}

function AutonomyByRisk({ settings, canManage, onChanged }: { settings: CosSettings; canManage: boolean; onChanged: () => void }) {
  const { t } = useChiefT();
  const { toast } = useToast();
  const { saving, run } = useSaving();
  const [modes, setModes] = useState<Partial<Record<RiskLevel, AutonomyMode>>>(settings.autonomy_by_risk ?? {});
  const [cap, setCap] = useState(settings.max_messages_per_day === null ? '' : String(settings.max_messages_per_day));

  // Follow the server after a reload (e.g. another admin changed it) instead of keeping stale local edits.
  const serverKey = JSON.stringify([settings.autonomy_by_risk, settings.max_messages_per_day]);
  useEffect(() => {
    setModes(settings.autonomy_by_risk ?? {});
    setCap(settings.max_messages_per_day === null ? '' : String(settings.max_messages_per_day));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverKey]);

  const parsedCap = parseCap(cap);

  const save = () =>
    run(async () => {
      if (!parsedCap.ok) return;
      // "Each agent's own setting" is expressed by leaving the level out of the map.
      const map: Partial<Record<RiskLevel, AutonomyMode>> = {};
      for (const r of RISKS) {
        const m = modes[r];
        if (m && !(r === 'critical' && m === 'auto')) map[r] = m; // critical can never be auto
      }
      try {
        await setAutonomyByRisk(map, parsedCap.value);
        toast(t('controls.autonomy.saved'), 'success');
        onChanged();
      } catch {
        toast(t('controls.autonomy.failed'), 'error');
      }
    });

  return (
    <section aria-labelledby="cos-autonomy">
      <h3 id="cos-autonomy" className="text-sm font-semibold text-text-primary">{t('controls.autonomy.title')}</h3>
      <p className="mt-0.5 text-xs text-text-secondary">{t('controls.autonomy.hint')}</p>
      <div className="mt-3 space-y-3">
        {RISKS.map((risk) => (
          <Select
            key={risk}
            label={t(`controls.autonomy.risk.${risk}`)}
            value={modes[risk] ?? ''}
            disabled={!canManage || saving}
            onChange={(e) => {
              const v = e.target.value as AutonomyMode | '';
              setModes((prev) => {
                const next = { ...prev };
                if (v) next[risk] = v;
                else delete next[risk];
                return next;
              });
            }}
          >
            <option value="">{t('controls.autonomy.mode.unset')}</option>
            {MODES.filter((m) => !(risk === 'critical' && m === 'auto')).map((m) => (
              <option key={m} value={m}>{t(`controls.autonomy.mode.${m}`)}</option>
            ))}
          </Select>
        ))}
        <Input
          label={t('controls.autonomy.messageCap')}
          helperText={t('controls.autonomy.messageCapHint')}
          inputMode="numeric"
          value={cap}
          disabled={!canManage || saving}
          aria-invalid={!parsedCap.ok || undefined}
          onChange={(e) => setCap(e.target.value)}
        />
      </div>
      <div className="mt-3">
        <Button
          size="sm"
          onClick={() => void save()}
          loading={saving}
          disabled={!canManage || !parsedCap.ok}
          disabledReason={canManage && !parsedCap.ok ? t('controls.autonomy.messageCapHint') : undefined}
        >
          {t('controls.autonomy.save')}
        </Button>
      </div>
    </section>
  );
}

function AgentDials({ dials, canManage, onChanged }: { dials: AgentDial[]; canManage: boolean; onChanged: () => void }) {
  const { t } = useChiefT();
  return (
    <section aria-labelledby="cos-dials">
      <h3 id="cos-dials" className="text-sm font-semibold text-text-primary">{t('controls.dials.title')}</h3>
      <p className="mt-0.5 text-xs text-text-secondary">{t('controls.dials.hint')}</p>
      <ul className="mt-3 space-y-4">
        {dials.map((d) => (
          <DialRow key={d.agent_source} dial={d} canManage={canManage} onChanged={onChanged} />
        ))}
      </ul>
    </section>
  );
}

function DialRow({ dial, canManage, onChanged }: { dial: AgentDial; canManage: boolean; onChanged: () => void }) {
  const { t } = useChiefT();
  const { toast } = useToast();
  const { saving, run } = useSaving();
  const [mode, setMode] = useState<AutonomyMode | ''>(dial.mode ?? '');
  const [cap, setCap] = useState(dial.max_messages_per_day === null ? '' : String(dial.max_messages_per_day));
  const parsedCap = parseCap(cap);
  const agent = dial.labels.length > 0 ? dial.labels.join(', ') : dial.agent_source;

  const save = () =>
    run(async () => {
      if (!mode || !parsedCap.ok) return;
      try {
        await setAgentDial(dial.agent_source, mode, dial.has_messaging ? parsedCap.value : null);
        toast(t('controls.dials.saved'), 'success');
        onChanged();
      } catch {
        toast(t('controls.autonomy.failed'), 'error');
      }
    });

  return (
    <li className="space-y-2 rounded-lg border border-border p-3">
      <Select
        label={t('controls.dials.agentLabel', { agent })}
        value={mode}
        disabled={!canManage || saving}
        onChange={(e) => setMode(e.target.value as AutonomyMode | '')}
      >
        {/* No mode saved yet: the placeholder is shown but cannot be saved, so a mode is never guessed. */}
        {mode === '' && <option value="">{t('controls.autonomy.mode.unset')}</option>}
        {MODES.map((m) => (
          <option key={m} value={m}>{t(`controls.autonomy.mode.${m}`)}</option>
        ))}
      </Select>
      {dial.has_messaging && (
        <Input
          label={t('controls.dials.capLabel', { agent })}
          inputMode="numeric"
          value={cap}
          disabled={!canManage || saving}
          aria-invalid={!parsedCap.ok || undefined}
          onChange={(e) => setCap(e.target.value)}
        />
      )}
      <Button
        size="xs"
        onClick={() => void save()}
        loading={saving}
        disabled={!canManage || mode === '' || !parsedCap.ok}
        disabledReason={canManage && mode !== '' && !parsedCap.ok ? t('controls.autonomy.messageCapHint') : undefined}
      >
        {t('controls.dials.save')}
      </Button>
    </li>
  );
}

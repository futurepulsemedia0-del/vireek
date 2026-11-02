import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Check, Download, Mic, MicOff, Pause, Play, RefreshCw, Square, Upload } from 'lucide-react';
import { useAccessibility } from '@/contexts/AccessibilityContext';
import { useTheme, type ThemePreference } from '@/contexts/ThemeContext';
import { LANGUAGES, type LanguageCode } from '@/lib/i18n';
import { announce } from '@/lib/a11y/announce';
import { downloadText, parseImportedSettings, serializeSettings } from '@/lib/a11y/importExport';
import { collectHeadings, collectLinks, jumpTo, type PageItem } from '@/lib/a11y/pageIndex';
import { PROFILE_DEFS, buildProfileSettings, detectActiveProfile } from '@/lib/a11y/profiles';
import type { RegistryItem } from '@/lib/a11y/registry';
import { COLOR_BLIND_MODES, DEFAULT_SETTINGS, RANGES } from '@/lib/a11y/settings';
import { DEFAULT_SHORTCUTS, SHORTCUT_ACTIONS, comboFromEvent, findConflict, formatCombo, isValidCombo, type ShortcutAction } from '@/lib/a11y/shortcuts';
import { getSpeechState, pauseSpeech, pickVoice, resumeSpeech, stopSpeech, subscribeSpeech } from '@/lib/a11y/speech';
import { detectSystemPreferences } from '@/lib/a11y/system';
import type { A11yKey } from '@/lib/a11y/strings';
import { useA11yText } from '../useA11yText';
import { Btn, Notice, SelectRow, SliderRow, ToggleRow } from './controls';
import { setCapturingShortcut, speakCurrent, useRuntime } from './runtime';

/* ---------------------------------- registry rows ---------------------------------- */
const fmt = (unit: 'percent' | 'plain' | 'em', v: number): string =>
  unit === 'percent' ? `${Math.round(v * 100)}%` : unit === 'em' ? `${v.toFixed(2)}em` : v.toFixed(1);

export function RegistryRow({ item }: { item: RegistryItem }) {
  const { settings, updateSetting } = useAccessibility();
  const { preference, setThemePreference } = useTheme();
  const { t } = useA11yText();
  const label = t(item.labelKey);
  const desc = t(item.descKey);
  const id = `a11y-${item.id}`;
  const c = item.control;
  if (c.kind === 'toggle') {
    return (
      <ToggleRow id={id} label={label} desc={desc} checked={settings[c.key]}
        onChange={(v) => { updateSetting(c.key, v); announce(t(v ? 'announceOn' : 'announceOff', { label })); }} />
    );
  }
  if (c.kind === 'slider') {
    const [min, max] = RANGES[c.key];
    const value = settings[c.key];
    return (
      <SliderRow id={id} label={label} desc={desc} value={value} min={min} max={max} step={c.step}
        display={fmt(c.unit, value)} decLabel={t('decrease', { label })} incLabel={t('increase', { label })} resetLabel={t('resetValue', { label })}
        onChange={(v) => updateSetting(c.key, v)} onReset={() => updateSetting(c.key, DEFAULT_SETTINGS[c.key])} />
    );
  }
  if (c.kind === 'colorBlind') {
    return (
      <SelectRow id={id} label={label} desc={desc} value={settings.colorBlind}
        options={COLOR_BLIND_MODES.map((m) => ({ value: m, label: t(`cb_${m}` as A11yKey) }))}
        onChange={(v) => { const m = COLOR_BLIND_MODES.find((x) => x === v); if (m) { updateSetting('colorBlind', m); announce(t('announceValue', { label, value: t(`cb_${m}` as A11yKey) })); } }} />
    );
  }
  return (
    <SelectRow id={id} label={label} desc={desc} value={preference}
      options={[{ value: 'light', label: t('themeLight') }, { value: 'dark', label: t('themeDark') }, { value: 'system', label: t('themeSystem') }]}
      onChange={(v) => { if (v === 'light' || v === 'dark' || v === 'system') setThemePreference(v as ThemePreference); }} />
  );
}

/* ------------------------------------- profiles ------------------------------------- */
export function ProfilesPanel() {
  const { settings, replaceSettings } = useAccessibility();
  const { t } = useA11yText();
  const active = detectActiveProfile(settings);
  return (
    <div>
      <p className="mb-2 break-words text-sm text-text-primary">{t('profilesHint')}</p>
      <ul className="grid grid-cols-1 gap-2">
        {PROFILE_DEFS.map((p) => {
          const on = active === p.id;
          return (
            <li key={p.id}>
              <button type="button" aria-pressed={on}
                onClick={() => { replaceSettings(buildProfileSettings(settings, p)); announce(t('profileApplied', { name: t(p.nameKey) })); }}
                className={`focus-ring flex min-h-[44px] w-full items-start gap-3 rounded-xl border-2 px-3 py-3 text-start ${on ? 'border-text-primary bg-bg-tertiary' : 'border-text-secondary bg-bg-secondary'}`}>
                <span className="min-w-0 flex-1">
                  <span className="block break-words text-base font-bold text-text-primary">{t(p.nameKey)}</span>
                  <span className="mt-0.5 block break-words text-sm text-text-primary">{t(p.descKey)}</span>
                </span>
                {on && <span className="flex shrink-0 items-center gap-1 text-sm font-bold text-text-primary"><Check size={16} aria-hidden="true" />{t('profileActive')}</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* --------------------------------------- TTS --------------------------------------- */
function useVoices(): SpeechSynthesisVoice[] {
  const [v, setV] = useState<SpeechSynthesisVoice[]>(() => ('speechSynthesis' in window ? window.speechSynthesis.getVoices() : []));
  useEffect(() => {
    if (!('speechSynthesis' in window)) return;
    const on = () => setV(window.speechSynthesis.getVoices());
    on();
    window.speechSynthesis.addEventListener('voiceschanged', on);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', on);
  }, []);
  return v;
}

export function TtsPanel() {
  const { settings, updateSetting, language } = useAccessibility();
  const { t } = useA11yText();
  const sp = useSyncExternalStore(subscribeSpeech, getSpeechState, () => ({ supported: false, speaking: false, paused: false, noVoice: false }));
  const voices = useVoices();
  const prefix = (language === 'zh' ? 'zh' : language).toLowerCase();
  const sorted = useMemo(() => [...voices].sort((a, b) => Number(b.lang.toLowerCase().startsWith(prefix)) - Number(a.lang.toLowerCase().startsWith(prefix)) || a.name.localeCompare(b.name)), [voices, prefix]);
  const missing = voices.length > 0 && !pickVoice(voices, language, settings.ttsVoiceURI);
  if (!sp.supported) return <Notice>{t('ttsUnsupported')}</Notice>;
  const row = (key: 'ttsRate' | 'ttsPitch' | 'ttsVolume', step: number, unit: 'plain' | 'percent') => {
    const [min, max] = RANGES[key];
    const label = t(key);
    return (
      <SliderRow id={`a11y-${key}`} label={label} value={settings[key]} min={min} max={max} step={step}
        display={unit === 'percent' ? `${Math.round(settings[key] * 100)}%` : `${settings[key].toFixed(1)}×`}
        decLabel={t('decrease', { label })} incLabel={t('increase', { label })} resetLabel={t('resetValue', { label })}
        onChange={(v) => updateSetting(key, v)} onReset={() => updateSetting(key, DEFAULT_SETTINGS[key])} />
    );
  };
  return (
    <div>
      <div className="flex flex-wrap gap-2">
        <Btn variant="primary" onClick={() => speakCurrent(settings, language, announce, t('ttsNothing'))}><Play size={16} aria-hidden="true" />{t('ttsRead')}</Btn>
        {sp.speaking && (
          <Btn onClick={() => (sp.paused ? resumeSpeech() : pauseSpeech())}>
            {sp.paused ? <Play size={16} aria-hidden="true" /> : <Pause size={16} aria-hidden="true" />}{sp.paused ? t('ttsResume') : t('ttsPause')}
          </Btn>
        )}
        <Btn onClick={() => { stopSpeech(); announce(t('ttsDone')); }} disabled={!sp.speaking}><Square size={16} aria-hidden="true" />{t('ttsStop')}</Btn>
      </div>
      {row('ttsRate', 0.1, 'plain')}
      {row('ttsPitch', 0.1, 'plain')}
      {row('ttsVolume', 0.1, 'percent')}
      <SelectRow id="a11y-ttsVoice" label={t('ttsVoice')} value={settings.ttsVoiceURI}
        options={[{ value: '', label: t('ttsVoiceAuto') }, ...sorted.map((v) => ({ value: v.voiceURI, label: `${v.name} (${v.lang})` }))]}
        onChange={(v) => updateSetting('ttsVoiceURI', v)} />
      {(missing || sp.noVoice) && <Notice>{t('ttsNoVoice')}</Notice>}
    </div>
  );
}

/* ------------------------------------ shortcuts ------------------------------------ */
export function ShortcutsPanel() {
  const { settings, updateSetting } = useAccessibility();
  const { t } = useA11yText();
  const [editing, setEditing] = useState<ShortcutAction | null>(null);
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null);
  const stop = () => { setEditing(null); setCapturingShortcut(false); };
  useEffect(() => () => setCapturingShortcut(false), []);
  const onKey = (action: ShortcutAction, e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (editing !== action) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') { stop(); return; }
    const combo = comboFromEvent(e.nativeEvent);
    if (!combo) return;
    if (!isValidCombo(combo)) { setMsg({ text: t('shortcutInvalid'), error: true }); announce(t('shortcutInvalid')); return; }
    const other = findConflict(settings.shortcuts, action, combo);
    if (other) { const text = t('shortcutConflict', { action: t(`sc_${other}` as A11yKey) }); setMsg({ text, error: true }); announce(text); return; }
    updateSetting('shortcuts', { ...settings.shortcuts, [action]: combo });
    const text = t('shortcutSaved', { combo: formatCombo(combo) });
    setMsg({ text, error: false });
    announce(text);
    stop();
  };
  return (
    <div>
      <p className="mb-2 break-words text-sm text-text-primary">{t('shortcutsHint')}</p>
      <ul>
        {SHORTCUT_ACTIONS.map((a) => (
          <li key={a} className="flex flex-wrap items-center justify-between gap-2 border-t-2 border-bg-tertiary py-2 first:border-t-0">
            <span className="min-w-0 flex-1 break-words text-base text-text-primary">{t(`sc_${a}` as A11yKey)}</span>
            <kbd dir="ltr" className="rounded-lg border-2 border-text-secondary bg-bg-tertiary px-2 py-1 font-mono text-sm font-bold text-text-primary">{formatCombo(settings.shortcuts[a])}</kbd>
            <Btn aria-label={`${t('shortcutChange')}: ${t(`sc_${a}` as A11yKey)}`}
              onClick={() => { setEditing(a); setCapturingShortcut(true); setMsg(null); }}
              onKeyDown={(e) => onKey(a, e)} onBlur={() => editing === a && stop()}>
              {editing === a ? t('shortcutPress') : t('shortcutChange')}
            </Btn>
          </li>
        ))}
      </ul>
      <Btn className="mt-2" onClick={() => { updateSetting('shortcuts', { ...DEFAULT_SHORTCUTS }); setMsg({ text: t('shortcutRestored'), error: false }); announce(t('shortcutRestored')); }}>{t('shortcutResetAll')}</Btn>
      {msg && <Notice tone={msg.error ? 'error' : 'info'}>{msg.text}</Notice>}
    </div>
  );
}

/* ------------------------------------- page map ------------------------------------- */
export function PageMapPanel() {
  const { t } = useA11yText();
  const { closeCenter } = useRuntime();
  const [mode, setMode] = useState<'headings' | 'links'>('headings');
  const [q, setQ] = useState('');
  const [rev, setRev] = useState(0);
  const items: PageItem[] = useMemo(() => (mode === 'headings' ? collectHeadings() : collectLinks()), [mode, rev]);
  const shown = items.filter((i) => i.text.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 300);
  const go = (it: PageItem) => {
    closeCenter();
    window.setTimeout(() => { jumpTo(it.el); announce(t('jumpedTo', { text: it.text })); }, 80);
  };
  return (
    <div>
      <div className="flex flex-wrap gap-2">
        <Btn aria-pressed={mode === 'headings'} onClick={() => setMode('headings')} className={mode === 'headings' ? '!border-text-primary !bg-bg-tertiary' : ''}>{t('headingsTab')}</Btn>
        <Btn aria-pressed={mode === 'links'} onClick={() => setMode('links')} className={mode === 'links' ? '!border-text-primary !bg-bg-tertiary' : ''}>{t('linksTab')}</Btn>
        <Btn aria-label={t('refresh')} onClick={() => setRev((r) => r + 1)}><RefreshCw size={16} aria-hidden="true" /></Btn>
      </div>
      <label htmlFor="a11y-pm-filter" className="mt-2 block text-sm font-semibold text-text-primary">{t('filterLabel')}</label>
      <input id="a11y-pm-filter" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('filterPlaceholder')}
        className="focus-ring mt-1 min-h-[44px] w-full rounded-xl border-2 border-text-secondary bg-bg-secondary px-3 py-2 text-base text-text-primary" />
      {shown.length === 0 ? (
        <Notice>{t(mode === 'headings' ? 'noHeadings' : 'noLinks')}</Notice>
      ) : (
        <ul className="mt-2 max-h-72 overflow-y-auto">
          {shown.map((it) => (
            <li key={`${mode}-${it.id}`}>
              <button type="button" onClick={() => go(it)} style={{ paddingInlineStart: `${Math.max(0, it.level - 1) * 14 + 12}px` }}
                className="focus-ring min-h-[44px] w-full break-words rounded-lg py-2 pe-3 text-start text-base text-text-primary underline decoration-2 underline-offset-2">
                {it.level > 0 && <span className="me-2 font-mono text-xs font-bold">H{it.level}</span>}{it.text}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* --------------------------------------- voice --------------------------------------- */
export function VoicePanel() {
  const { t } = useA11yText();
  const { voice } = useRuntime();
  if (!voice.supported) return <Notice>{t('voiceUnsupported')}</Notice>;
  return (
    <div>
      <p className="break-words text-sm text-text-primary">{t('voiceNotice')}</p>
      <Btn variant={voice.active ? 'secondary' : 'primary'} className="mt-2" onClick={voice.active ? voice.stop : voice.start}>
        {voice.active ? <MicOff size={16} aria-hidden="true" /> : <Mic size={16} aria-hidden="true" />}
        {voice.active ? t('voiceStop') : t('voiceStart')}
      </Btn>
      {voice.heard && <p className="mt-2 break-words text-sm font-semibold text-text-primary">{t('voiceHeard', { text: voice.heard })}</p>}
      {voice.message && <Notice>{voice.message}</Notice>}
      <p className="mt-2 break-words text-sm text-text-primary">{t('voiceHelp')}</p>
    </div>
  );
}

/* -------------------------------------- language -------------------------------------- */
export function LanguagePanel() {
  const { language, setLanguage } = useAccessibility();
  const { t } = useA11yText();
  return (
    <div>
      <p className="mb-2 break-words text-sm text-text-primary">{t('languageHint')}</p>
      <div role="radiogroup" aria-label={t('languageTitle')} className="grid grid-cols-1 gap-2">
        {LANGUAGES.map((l) => {
          const on = l.code === language;
          return (
            <button key={l.code} type="button" role="radio" aria-checked={on} lang={l.code} dir={l.direction}
              onClick={() => { setLanguage(l.code as LanguageCode); announce(t('languageChanged', { name: l.nativeName })); }}
              className={`focus-ring flex min-h-[44px] items-center justify-between gap-3 rounded-xl border-2 px-3 py-2 text-start ${on ? 'border-text-primary bg-bg-tertiary' : 'border-text-secondary bg-bg-secondary'}`}>
              <span className="text-base font-semibold text-text-primary"><span aria-hidden="true">{l.flag} </span>{l.nativeName}<span className="ms-2 text-sm font-normal">({l.name})</span></span>
              {on && <Check size={18} aria-hidden="true" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------------------------------- data ---------------------------------------- */
export function DataPanel() {
  const { settings, replaceSettings } = useAccessibility();
  const { t } = useA11yText();
  const { sync } = useRuntime();
  const fileRef = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null);
  const say = (text: string, error = false) => { setMsg({ text, error }); announce(text); };
  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 40_000) return say(t('importErr_tooLarge'), true);
    let text = '';
    try { text = await file.text(); } catch { return say(t('importErr_read'), true); }
    const r = parseImportedSettings(text);
    if (!r.ok) return say(t(`importErr_${r.reason}` as A11yKey), true);
    replaceSettings(r.settings);
    say(t('importOk'));
  };
  const statusKey = sync.status === 'syncing' ? 'syncSyncing' : sync.status === 'synced' ? 'syncSynced' : sync.status === 'error' ? 'syncError' : null;
  return (
    <div className="space-y-4">
      <div>
        <p className="break-words text-sm text-text-primary">{t('dataSystemHint')}</p>
        <Btn className="mt-2" onClick={() => {
          const p = detectSystemPreferences(window);
          if (Object.keys(p).length === 0) return say(t('systemNone'));
          replaceSettings({ ...settings, ...p });
          say(t('systemApplied'));
        }}>{t('dataSystem')}</Btn>
      </div>
      <div className="flex flex-wrap gap-2">
        <Btn onClick={() => { downloadText('vireek-accessibility.json', serializeSettings(settings)); say(t('exportDone')); }}><Download size={16} aria-hidden="true" />{t('dataExport')}</Btn>
        <Btn onClick={() => fileRef.current?.click()}><Upload size={16} aria-hidden="true" />{t('dataImport')}</Btn>
        <input ref={fileRef} type="file" accept="application/json,.json" className="sr-only" tabIndex={-1} aria-hidden="true"
          onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ''; }} />
      </div>
      {msg && <Notice tone={msg.error ? 'error' : 'info'}>{msg.text}</Notice>}
      <div className="border-t-2 border-bg-tertiary pt-3">
        <ToggleRow id="a11y-sync" label={t('syncTitle')} desc={t('syncHint')} checked={sync.enabled} onChange={sync.setEnabled} />
        {sync.enabled && !sync.signedIn && <Notice>{t('syncSignIn')}</Notice>}
        {sync.enabled && sync.signedIn && statusKey && <Notice tone={sync.status === 'error' ? 'error' : 'info'}>{t(statusKey)}</Notice>}
        {sync.signedIn && <Btn className="mt-2" onClick={() => void sync.deleteCloud()}>{t('syncDelete')}</Btn>}
      </div>
    </div>
  );
}

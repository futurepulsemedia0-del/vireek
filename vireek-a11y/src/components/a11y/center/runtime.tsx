import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useAccessibility } from '@/contexts/AccessibilityContext';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/lib/supabase';
import { announce } from '@/lib/a11y/announce';
import { getReadableText, findClickable, jumpToAdjacentHeading } from '@/lib/a11y/pageIndex';
import { RANGES, type AccessibilitySettings } from '@/lib/a11y/settings';
import { comboFromEvent, matchAction } from '@/lib/a11y/shortcuts';
import { LANG_TAG, speak, stopSpeech } from '@/lib/a11y/speech';
import { createRecognizer, isVoiceSupported, normalizeSpeech, parseVoiceCommand, type RecognizerHandle } from '@/lib/a11y/voiceNav';
import {
  decideSync, deleteRemote, fetchRemote, getSyncStatus, pushRemote, readEditedAt, readLocalAt, readSyncEnabled,
  setSyncStatus, subscribeSync, writeEditedAt, writeLocalAt, writeSyncEnabled, type PrefsClient, type SyncStatus,
} from '@/lib/a11y/sync';
import type { CenterTab } from '@/lib/a11y/registry';
import { useA11yText } from '../useA11yText';

/* ------------------------------ shortcut capture flag ------------------------------ */
let capturing = false;
export const setCapturingShortcut = (v: boolean): void => { capturing = v; };

const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const smooth = (): ScrollBehavior =>
  document.documentElement.classList.contains('a11y-reduce-motion') || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';

export function speakCurrent(s: AccessibilitySettings, language: string, say: (m: string) => void, nothing: string): void {
  const r = speak(getReadableText(), { lang: language, rate: s.ttsRate, pitch: s.ttsPitch, volume: s.ttsVolume, voiceURI: s.ttsVoiceURI });
  if (r !== 'started') say(nothing);
}

/* ---------------------------------- voice navigation ---------------------------------- */
export interface VoiceApi { supported: boolean; active: boolean; heard: string; message: string; start(): void; stop(): void }

function useVoiceNav(): VoiceApi {
  const { settings, updateSetting, language } = useAccessibility();
  const { t } = useA11yText();
  const sRef = useRef(settings); sRef.current = settings;
  const lRef = useRef(language); lRef.current = language;
  const tRef = useRef(t); tRef.current = t;
  const [st, setSt] = useState({ active: false, heard: '', message: '' });
  const recRef = useRef<RecognizerHandle | null>(null);
  const want = useRef(false);
  const say = useCallback((message: string) => { setSt((s) => ({ ...s, message })); announce(message); }, []);

  const run = useCallback((raw: string) => {
    setSt((s) => ({ ...s, heard: raw }));
    const cmd = parseVoiceCommand(raw, lRef.current);
    const T = tRef.current;
    if (!cmd) return say(T('voiceUnknown'));
    switch (cmd.type) {
      case 'scroll': window.scrollBy({ top: (cmd.dir === 'down' ? 1 : -1) * window.innerHeight * 0.8, behavior: smooth() }); break;
      case 'edge': window.scrollTo({ top: cmd.edge === 'top' ? 0 : document.documentElement.scrollHeight, behavior: smooth() }); break;
      case 'history': if (cmd.dir === 'back') window.history.back(); else window.history.forward(); break;
      case 'heading': { const h = jumpToAdjacentHeading(cmd.dir); if (h) say(T('jumpedTo', { text: h })); break; }
      case 'read': speakCurrent(sRef.current, lRef.current, say, T('ttsNothing')); break;
      case 'stop': stopSpeech(); break;
      case 'help': say(T('voiceHelp')); break;
      case 'contrast': updateSetting('highContrast', !sRef.current.highContrast); break;
      case 'textSize': {
        const [lo, hi] = RANGES.textSize;
        const v = Math.min(hi, Math.max(lo, round3(sRef.current.textSize + (cmd.dir === 'up' ? 0.125 : -0.125))));
        updateSetting('textSize', v);
        say(T('announceValue', { label: T('lbl_textSize'), value: `${Math.round(v * 100)}%` }));
        break;
      }
      case 'click': {
        const m = findClickable(cmd.target, normalizeSpeech);
        if (!m) return say(T('voiceNoMatch', { text: cmd.target }));
        if (m.blocked) return say(T('voiceBlocked'));
        m.el.focus();
        m.el.click();
        say(T('voiceClicked', { text: m.name }));
        break;
      }
    }
  }, [say, updateSetting]);

  const beginRef = useRef<() => void>(() => undefined);
  const begin = useCallback(() => {
    const rec = createRecognizer({
      lang: LANG_TAG[lRef.current] ?? 'en-US',
      onFinal: run,
      onError: (code) => {
        if (code === 'not-allowed' || code === 'service-not-allowed') { want.current = false; say(tRef.current('voiceDenied')); }
        else if (code !== 'no-speech' && code !== 'aborted') say(tRef.current('voiceError', { code }));
      },
      onEnd: () => {
        recRef.current = null;
        if (want.current) window.setTimeout(() => { if (want.current && !recRef.current) beginRef.current(); }, 300);
        else setSt((s) => ({ ...s, active: false }));
      },
    });
    if (!rec) return;
    recRef.current = rec;
    try { rec.start(); } catch { recRef.current = null; }
  }, [run, say]);
  beginRef.current = begin;

  const start = useCallback(() => {
    if (!isVoiceSupported() || want.current) return;
    want.current = true;
    setSt((s) => ({ ...s, active: true }));
    say(tRef.current('voiceListening'));
    begin();
  }, [begin, say]);
  const stop = useCallback(() => {
    want.current = false;
    recRef.current?.stop();
    setSt((s) => ({ ...s, active: false }));
    announce(tRef.current('voiceStopped'));
  }, []);
  useEffect(() => () => { want.current = false; recRef.current?.stop(); }, []);
  return { supported: isVoiceSupported(), ...st, start, stop };
}

/* ------------------------------------ shortcuts ------------------------------------ */
function useShortcuts(openCenter: (tab?: CenterTab) => void): void {
  const { settings, updateSetting, resetAll, language } = useAccessibility();
  const { t } = useA11yText();
  const sRef = useRef(settings); sRef.current = settings;
  const lRef = useRef(language); lRef.current = language;
  const tRef = useRef(t); tRef.current = t;
  useEffect(() => {
    const flag = (key: 'highContrast' | 'focusMode', labelKey: 'lbl_highContrast' | 'lbl_focusMode') => {
      const next = !sRef.current[key];
      updateSetting(key, next);
      announce(tRef.current(next ? 'announceOn' : 'announceOff', { label: tRef.current(labelKey) }));
    };
    const size = (d: number) => {
      const [lo, hi] = RANGES.textSize;
      const v = Math.min(hi, Math.max(lo, round3(sRef.current.textSize + d)));
      updateSetting('textSize', v);
      announce(tRef.current('announceValue', { label: tRef.current('lbl_textSize'), value: `${Math.round(v * 100)}%` }));
    };
    const onKey = (e: KeyboardEvent) => {
      if (capturing) return;
      const combo = comboFromEvent(e);
      const action = combo ? matchAction(sRef.current.shortcuts, combo) : null;
      if (!action) return;
      e.preventDefault();
      switch (action) {
        case 'openCenter': openCenter(); break;
        case 'openPageMap': openCenter('navigation'); break;
        case 'toggleContrast': flag('highContrast', 'lbl_highContrast'); break;
        case 'toggleFocusMode': flag('focusMode', 'lbl_focusMode'); break;
        case 'textLarger': size(0.125); break;
        case 'textSmaller': size(-0.125); break;
        case 'readSelection': speakCurrent(sRef.current, lRef.current, announce, tRef.current('ttsNothing')); break;
        case 'stopSpeech': stopSpeech(); break;
        case 'resetAll': resetAll(); announce(tRef.current('resetDone')); break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openCenter, updateSetting, resetAll]);
}

/* ------------------------------------ cloud sync ------------------------------------ */
export interface SyncApi { enabled: boolean; signedIn: boolean; status: SyncStatus; setEnabled(on: boolean): void; deleteCloud(): Promise<void> }

function useCloudSync(): SyncApi {
  const { user } = useAuth();
  const { settings, replaceSettings } = useAccessibility();
  const { t } = useA11yText();
  const [enabled, setEnabledState] = useState<boolean>(readSyncEnabled);
  const status = useSyncExternalStore(subscribeSync, getSyncStatus, () => 'off' as SyncStatus);
  const sRef = useRef(settings); sRef.current = settings;
  const tRef = useRef(t); tRef.current = t;
  const lastJson = useRef(JSON.stringify(settings));
  const ready = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const client = supabase as unknown as PrefsClient;
  const uid = user?.id;

  useEffect(() => {
    ready.current = false;
    if (!enabled) { setSyncStatus('off'); return; }
    if (!uid) { setSyncStatus('signedOut'); return; }
    let cancelled = false;
    void (async () => {
      setSyncStatus('syncing');
      const r = await fetchRemote(client, uid);
      if (cancelled) return;
      if (!r.ok) { setSyncStatus('error'); return; }
      const decision = decideSync(readLocalAt(), readEditedAt(), r.remote);
      if (decision === 'pull' && r.remote) {
        lastJson.current = JSON.stringify(r.remote.settings);
        replaceSettings(r.remote.settings);
        writeLocalAt(r.remote.updatedAt);
        announce(tRef.current('syncPulled'));
        setSyncStatus('synced');
      } else if (decision === 'push') {
        const p = await pushRemote(client, uid, sRef.current);
        if (cancelled) return;
        if (!p.ok) { setSyncStatus('error'); return; }
        lastJson.current = JSON.stringify(sRef.current);
        writeLocalAt(p.updatedAt);
        setSyncStatus('synced');
      } else {
        lastJson.current = JSON.stringify(sRef.current);
        setSyncStatus('synced');
      }
      ready.current = true;
    })();
    return () => { cancelled = true; };
  }, [enabled, uid, client, replaceSettings]);

  useEffect(() => {
    const json = JSON.stringify(settings);
    if (json === lastJson.current) return;
    writeEditedAt(Date.now());
    if (!enabled || !uid || !ready.current) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setSyncStatus('syncing');
      void pushRemote(client, uid, settings).then((p) => {
        if (p.ok) { lastJson.current = json; writeLocalAt(p.updatedAt); setSyncStatus('synced'); } else setSyncStatus('error');
      });
    }, 1500);
    return () => window.clearTimeout(timer.current);
  }, [settings, enabled, uid, client]);

  const setEnabled = useCallback((on: boolean) => {
    writeSyncEnabled(on);
    setEnabledState(on);
    announce(tRef.current(on ? 'syncOn' : 'syncOff'));
  }, []);
  const deleteCloud = useCallback(async () => {
    if (!uid) return;
    const r = await deleteRemote(client, uid);
    if (r.ok) { writeLocalAt(0); announce(tRef.current('syncDeleted')); } else setSyncStatus('error');
  }, [uid, client]);
  return { enabled, signedIn: Boolean(uid), status, setEnabled, deleteCloud };
}

/* ------------------------------------- context ------------------------------------- */
export interface Runtime { voice: VoiceApi; sync: SyncApi; closeCenter(): void; openCenter(tab?: CenterTab): void }
const RuntimeCtx = createContext<Runtime | null>(null);

export function useRuntimeValue(openCenter: (tab?: CenterTab) => void, closeCenter: () => void): Runtime {
  const voice = useVoiceNav();
  const sync = useCloudSync();
  useShortcuts(openCenter);
  return { voice, sync, openCenter, closeCenter };
}
export const RuntimeProvider = RuntimeCtx.Provider;
export function useRuntime(): Runtime {
  const v = useContext(RuntimeCtx);
  if (!v) throw new Error('useRuntime must be used inside AccessibilityCenter');
  return v;
}

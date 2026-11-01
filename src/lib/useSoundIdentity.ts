import { useCallback, useState } from 'react';
import {
  loadSoundPrefs, playSoundEvent, saveSoundPrefs,
  type PlayResult, type SoundCue, type SoundEvent, type SoundPrefs,
} from '@/lib/soundIdentity';

/** React wrapper: prefs persistence + a visual cue (`lastCue`) that mirrors every sound for a11y. */
export function useSoundIdentity() {
  const [prefs, setPrefsState] = useState<SoundPrefs>(() => loadSoundPrefs());
  const [lastCue, setLastCue] = useState<SoundCue | null>(null);

  const setPrefs = useCallback((next: SoundPrefs) => {
    setPrefsState(next);
    saveSoundPrefs(next);
  }, []);

  const play = useCallback(
    (event: SoundEvent, opts: { preview?: boolean } = {}): Promise<PlayResult> =>
      playSoundEvent(event, { prefs, pathname: window.location.pathname, announce: setLastCue, preview: opts.preview }),
    [prefs],
  );

  return { prefs, setPrefs, play, lastCue };
}

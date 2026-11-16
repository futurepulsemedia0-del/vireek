/** Applies the "mute all media" and "always show captions" preferences to <video>/<audio> (including ones added later).
 *  Returns a cleanup that restores what it changed. Embedded players (YouTube, Vimeo iframes) cannot be controlled from here. */
export interface MediaPrefs { mute: boolean; captions: boolean }

const CAPTION_KINDS = new Set(['captions', 'subtitles']);

export function startMediaPrefs(prefs: MediaPrefs, doc: Document = document): (() => void) | undefined {
  if (!prefs.mute && !prefs.captions) return undefined;
  const prevMuted = new WeakMap<HTMLMediaElement, boolean>();
  const prevModes = new WeakMap<TextTrack, TextTrackMode>();
  const touched = new Set<HTMLMediaElement>();

  const muteOne = (m: HTMLMediaElement): void => {
    if (!prevMuted.has(m)) prevMuted.set(m, m.muted);
    if (!m.muted) m.muted = true;
  };
  const showCaptions = (m: HTMLMediaElement): void => {
    const tracks = Array.from(m.textTracks ?? []).filter((t) => CAPTION_KINDS.has(t.kind));
    if (tracks.length === 0 || tracks.some((t) => t.mode === 'showing')) return;
    const lang = (doc.documentElement.lang || '').toLowerCase().split('-')[0];
    const pick = tracks.find((t) => t.language.toLowerCase().startsWith(lang) && lang !== '') ?? tracks[0];
    prevModes.set(pick, pick.mode);
    pick.mode = 'showing';
  };
  const handle = (m: HTMLMediaElement): void => {
    touched.add(m);
    if (prefs.mute) muteOne(m);
    if (prefs.captions) {
      showCaptions(m);
      m.textTracks?.addEventListener('addtrack', () => showCaptions(m));
    }
  };
  const scan = (root: ParentNode): void => root.querySelectorAll<HTMLMediaElement>('video,audio').forEach(handle);

  const onVolume = (e: Event): void => {
    const t = e.target;
    if (prefs.mute && t instanceof HTMLMediaElement && !t.muted) t.muted = true;
  };
  const onMeta = (e: Event): void => {
    const t = e.target;
    if (prefs.captions && t instanceof HTMLVideoElement) showCaptions(t);
  };

  scan(doc);
  doc.addEventListener('volumechange', onVolume, true);
  doc.addEventListener('loadedmetadata', onMeta, true);
  const mo = new MutationObserver((records) => {
    for (const r of records)
      r.addedNodes.forEach((n) => {
        if (!(n instanceof Element)) return;
        if (n instanceof HTMLMediaElement) handle(n);
        scan(n);
      });
  });
  if (doc.body) mo.observe(doc.body, { childList: true, subtree: true });

  return () => {
    doc.removeEventListener('volumechange', onVolume, true);
    doc.removeEventListener('loadedmetadata', onMeta, true);
    mo.disconnect();
    touched.forEach((m) => {
      const was = prevMuted.get(m);
      if (was !== undefined) m.muted = was;
      Array.from(m.textTracks ?? []).forEach((t) => {
        const mode = prevModes.get(t);
        if (mode) t.mode = mode;
      });
    });
  };
}

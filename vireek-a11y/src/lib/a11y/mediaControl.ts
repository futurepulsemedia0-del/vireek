/** Pauses auto-playing <video>/<audio> (incl. later-inserted ones) unless the user started playback. Returns cleanup. */
export function startMediaGuard(doc: Document = document): () => void {
  const userStarted = (): boolean => navigator.userActivation?.isActive ?? false;
  const tame = (m: HTMLMediaElement): void => {
    m.autoplay = false;
    m.removeAttribute('autoplay');
    if (!m.paused && !userStarted()) m.pause();
  };
  const onPlay = (e: Event): void => {
    const t = e.target;
    if (t instanceof HTMLMediaElement && !userStarted()) t.pause();
  };
  doc.querySelectorAll<HTMLMediaElement>('video,audio').forEach(tame);
  doc.addEventListener('play', onPlay, true);
  const mo = new MutationObserver((records) => {
    for (const r of records)
      r.addedNodes.forEach((n) => {
        if (!(n instanceof Element)) return;
        if (n instanceof HTMLMediaElement) tame(n);
        n.querySelectorAll?.<HTMLMediaElement>('video,audio').forEach(tame);
      });
  });
  mo.observe(doc.body, { childList: true, subtree: true });
  return () => {
    doc.removeEventListener('play', onPlay, true);
    mo.disconnect();
  };
}

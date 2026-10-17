import { useEffect, useRef, useState } from 'react';
import { Mic, Pause, Play } from 'lucide-react';
import { formatDuration } from '@/lib/teamChat';

/** Voice note player: play/pause, scrubbable progress, duration. */
export function ChatVoicePlayer({ url, durationMs, own }: { url: string | null; durationMs: number; own: boolean }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progressMs, setProgressMs] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = audioRef.current;
    return () => {
      el?.pause();
    };
  }, []);

  const toggle = async () => {
    const el = audioRef.current;
    if (!el || !url) return;
    try {
      if (el.paused) {
        await el.play();
      } else {
        el.pause();
      }
    } catch {
      setFailed(true);
    }
  };

  const tone = own ? 'text-white' : 'text-text-primary';

  return (
    <div className={`flex min-w-[200px] items-center gap-3 ${tone}`}>
      <button
        type="button"
        onClick={toggle}
        disabled={!url}
        aria-label={playing ? 'Pause voice note' : 'Play voice note'}
        className={`focus-ring flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full ${
          own ? 'bg-white/20 hover:bg-white/30' : 'bg-accent/10 text-accent hover:bg-accent/20'
        } disabled:opacity-50`}
      >
        {playing ? <Pause size={18} /> : <Play size={18} className="translate-x-px" />}
      </button>
      <div className="min-w-0 flex-1">
        <input
          type="range"
          min={0}
          max={Math.max(durationMs, 1)}
          value={Math.min(progressMs, durationMs)}
          onChange={(e) => {
            const v = Number(e.target.value);
            setProgressMs(v);
            if (audioRef.current) audioRef.current.currentTime = v / 1000;
          }}
          aria-label="Voice note position"
          className="h-1.5 w-full cursor-pointer appearance-none rounded-full accent-current"
          style={{
            background: `linear-gradient(to right, currentColor ${(progressMs / Math.max(durationMs, 1)) * 100}%, transparent 0)`,
          }}
          disabled={!url}
        />
        <div className={`mt-1 flex items-center justify-between text-xs ${own ? 'text-white/80' : 'text-text-secondary'}`}>
          <span className="inline-flex items-center gap-1">
            <Mic size={12} aria-hidden="true" />
            {failed ? 'Cannot play' : formatDuration(playing || progressMs > 0 ? progressMs : durationMs)}
          </span>
          {(playing || progressMs > 0) && <span>{formatDuration(durationMs)}</span>}
        </div>
      </div>
      {url && (
        <audio
          ref={audioRef}
          src={url}
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false);
            setProgressMs(0);
          }}
          onTimeUpdate={(e) => setProgressMs(Math.round(e.currentTarget.currentTime * 1000))}
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
}

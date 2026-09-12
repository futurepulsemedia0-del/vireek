import { useEffect, useState, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Voicemail,
  Play,
  Pause,
  Volume2,
  MessageSquare,
  CheckCircle2,
  Circle,
  Phone,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { supabase, Call } from '@/lib/supabase';

// ============================================================
// HELPERS
// ============================================================

function formatDuration(seconds: number | null): string {
  if (!seconds) return '—';
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs}s`;
}

function formatDateTime(dateStr: string): string {
  return new Date(dateStr).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

// ============================================================
// AUDIO PLAYER (self-contained — mirrors CallsPage.tsx styling)
// ============================================================

function AudioPlayer({ url }: { url: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTime = () => {
      setProgress(audio.currentTime);
      setDuration(audio.duration || 0);
    };
    const onEnd = () => setPlaying(false);
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('ended', onEnd);
    audio.addEventListener('loadedmetadata', onTime);
    return () => {
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('ended', onEnd);
      audio.removeEventListener('loadedmetadata', onTime);
    };
  }, []);

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
      setPlaying(false);
    } else {
      audio.play().catch(() => {});
      setPlaying(true);
    }
  };

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const audio = audioRef.current;
    if (!audio || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    audio.currentTime = pct * duration;
  };

  const pct = duration > 0 ? (progress / duration) * 100 : 0;

  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-bg-primary p-3">
      <audio ref={audioRef} src={url} preload="metadata" />
      <button
        type="button"
        onClick={toggle}
        className="focus-ring flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent text-white transition-transform hover:scale-105"
      >
        {playing ? <Pause size={18} /> : <Play size={18} className="ml-0.5" />}
      </button>
      <div className="flex-1">
        <div className="flex items-center gap-2">
          <Volume2 size={14} className="text-text-secondary" />
          <div
            className="flex-1 cursor-pointer rounded-full bg-bg-tertiary"
            style={{ height: 6 }}
            onClick={seek}
          >
            <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
          </div>
          <span className="text-xs text-text-secondary tabular-nums">
            {Math.floor(progress / 60)}:{String(Math.floor(progress % 60)).padStart(2, '0')} / {Math.floor(duration / 60)}:{String(Math.floor(duration % 60)).padStart(2, '0')}
          </span>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// VOICEMAIL CARD
// ============================================================

function VoicemailCard({
  call,
  onMarkListened,
}: {
  call: Call;
  onMarkListened: (call: Call) => void;
}) {
  const listened = Boolean(call.voicemail_listened_at);

  return (
    <div
      className={`rounded-2xl border p-5 transition-colors ${
        listened ? 'border-border bg-bg-secondary' : 'border-accent/40 bg-accent/5'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Voicemail size={20} />
          </span>
          <div>
            <p className="text-sm font-semibold text-text-primary">
              {call.caller_name || 'Unknown caller'}
            </p>
            <p className="flex items-center gap-1 text-xs text-text-secondary">
              <Phone size={11} />
              {call.caller_phone || 'No phone on file'}
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => onMarkListened(call)}
          disabled={listened}
          className={`focus-ring flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
            listened
              ? 'cursor-default bg-success-500/10 text-success-500'
              : 'bg-bg-tertiary text-text-secondary hover:bg-accent/10 hover:text-accent'
          }`}
        >
          {listened ? <CheckCircle2 size={13} /> : <Circle size={13} />}
          {listened ? 'Listened' : 'Mark listened'}
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-secondary">
        <span>{formatDateTime(call.call_datetime)}</span>
        <span>{formatDuration(call.duration_seconds)}</span>
      </div>

      {call.recording_url && (
        <div className="mt-4">
          <AudioPlayer url={call.recording_url} />
        </div>
      )}

      {call.transcript && (
        <div className="mt-4">
          <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-text-secondary">
            <MessageSquare size={12} />
            Transcript
          </p>
          <div className="max-h-48 overflow-y-auto rounded-xl border border-border bg-bg-primary p-4">
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-text-primary">
              {call.transcript}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// PAGE
// ============================================================

export function VoicemailsPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [voicemails, setVoicemails] = useState<Call[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'unheard'>('all');

  const fetchVoicemails = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('calls')
      .select('*')
      .eq('is_voicemail', true)
      .order('call_datetime', { ascending: false });

    if (error) {
      toast('Failed to load voicemails', 'error');
    } else {
      setVoicemails((data as Call[]) || []);
    }
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    if (user) fetchVoicemails();
  }, [user, fetchVoicemails]);

  const handleMarkListened = async (call: Call) => {
    const { error } = await supabase
      .from('calls')
      .update({ voicemail_listened_at: new Date().toISOString() })
      .eq('id', call.id);

    if (error) {
      toast('Could not update voicemail', 'error');
      return;
    }
    setVoicemails((prev) =>
      prev.map((v) =>
        v.id === call.id ? { ...v, voicemail_listened_at: new Date().toISOString() } : v
      )
    );
  };

  const filtered = voicemails.filter((v) =>
    filter === 'unheard' ? !v.voicemail_listened_at : true
  );
  const unheardCount = voicemails.filter((v) => !v.voicemail_listened_at).length;

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-text-primary">Voicemails</h1>
            <p className="mt-1 text-sm text-text-secondary">
              {unheardCount > 0 ? `${unheardCount} unheard` : 'All caught up'}
            </p>
          </div>
          <div className="flex gap-2">
            {(['all', 'unheard'] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={`focus-ring rounded-full px-4 py-1.5 text-sm font-medium capitalize transition-colors ${
                  filter === f
                    ? 'bg-accent text-white'
                    : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'
                }`}
              >
                {f}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-32 animate-pulse rounded-2xl bg-bg-tertiary" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border py-16 text-center">
            <Voicemail size={32} className="mx-auto mb-3 text-text-secondary" />
            <p className="text-sm text-text-secondary">No voicemails to show.</p>
          </div>
        ) : (
          <AnimatePresence mode="popLayout">
            <div className="space-y-3">
              {filtered.map((call) => (
                <motion.div
                  key={call.id}
                  layout
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                >
                  <VoicemailCard call={call} onMarkListened={handleMarkListened} />
                </motion.div>
              ))}
            </div>
          </AnimatePresence>
        )}
      </div>
    </DashboardLayout>
  );
}

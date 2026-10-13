import { useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { describeDue, isReminderDue } from '@/lib/tasks';
import { fetchReminderCandidates } from '@/lib/tasksApi';

const POLL_MS = 60_000;
const MIN_GAP_MS = 45_000;
const STORAGE_PREFIX = 'vireek_task_reminders_v1:';

// DashboardLayout remounts on every navigation; this keeps us from querying
// more than about once a minute per tab regardless of how often that happens.
let lastRunAt = 0;

function readSeen(key: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(key);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function writeSeen(key: string, seen: Set<string>) {
  try {
    window.localStorage.setItem(key, JSON.stringify([...seen].slice(-200)));
  } catch {
    // Storage can be blocked (private mode); worst case a reminder repeats.
  }
}

/**
 * Renders nothing. While the dashboard is open it shows each task reminder
 * once per device as a toast. Mounted inside DashboardLayout.
 */
export function TaskReminderWatcher() {
  const { user, isOwner, teamMember } = useAuth();
  const { toast } = useToast();
  const userId = user?.id ?? null;
  const canAccess = isOwner || teamMember !== null;

  useEffect(() => {
    if (!userId || !canAccess) return;
    let cancelled = false;
    const storageKey = `${STORAGE_PREFIX}${userId}`;

    const check = async () => {
      const nowMs = Date.now();
      if (nowMs - lastRunAt < MIN_GAP_MS) return;
      lastRunAt = nowMs;
      try {
        const candidates = await fetchReminderCandidates(userId);
        if (cancelled) return;
        const now = new Date();
        const seen = readSeen(storageKey);
        let changed = false;
        for (const t of candidates) {
          if (!isReminderDue(t, now)) continue;
          // Key includes due_at + offset so editing a task re-arms its reminder.
          const key = `${t.id}:${t.due_at}:${t.reminder_offset_minutes}`;
          if (seen.has(key)) continue;
          seen.add(key);
          changed = true;
          toast(`Reminder: ${t.title} — ${describeDue(t, now).text}`, 'info');
        }
        if (changed) writeSeen(storageKey, seen);
      } catch {
        // Reminders are best-effort; never surface a failure for a background poll.
      }
    };

    void check();
    const id = setInterval(() => void check(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [userId, canAccess, toast]);

  return null;
}

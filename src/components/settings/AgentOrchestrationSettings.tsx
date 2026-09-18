import { useEffect, useState } from 'react';
import { Users2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { supabase } from '@/lib/supabase';

/**
 * Dashboard settings card for "AI Agent Orchestration" — splits the single
 * receptionist assistant into a squad of specialized agents (Router,
 * Scheduler, Emergency Triage, Pricing & Info, Account & History) that hand
 * off to each other mid-call. Drop this into BusinessProfilePage.tsx next
 * to EscalationSettings — it manages its own state and persists to the
 * `agent_orchestration_enabled` column on `profiles` (see the migration
 * that adds it).
 *
 * NOTE: this only saves the on/off preference. The actual squad behavior —
 * which specialist handles what, and the handoff rules between them — is
 * implemented server-side in
 * supabase/functions/_shared/ai-core/agentOrchestration.ts and wired into
 * supabase/functions/vapi-webhook/index.ts's assistant-request handler.
 */
export function AgentOrchestrationSettings() {
  const { profile, refreshProfile } = useAuth();
  const { toast } = useToast();

  const [enabled, setEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!profile) return;
    setEnabled(profile.agent_orchestration_enabled ?? false);
    setDirty(false);
  }, [profile]);

  const handleToggle = (next: boolean) => {
    setEnabled(next);
    setDirty(true);
  };

  const handleSave = async () => {
    if (!profile) return;
    setSaving(true);
    const { error } = await supabase
      .from('profiles')
      .update({ agent_orchestration_enabled: enabled })
      .eq('id', profile.id);

    if (error) {
      toast('Could not save agent orchestration settings. Please try again.', 'error');
    } else {
      toast('Agent orchestration settings saved.', 'success');
      setDirty(false);
      await refreshProfile();
    }
    setSaving(false);
  };

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-indigo-50 p-2">
          <Users2 className="h-5 w-5 text-indigo-600" />
        </div>
        <div className="flex-1">
          <h3 className="text-base font-semibold text-slate-900">AI Agent Orchestration</h3>
          <p className="mt-1 text-sm text-slate-500">
            Split your AI receptionist into specialized agents — a router, a scheduler, an
            emergency triage agent, a pricing/info agent, and an account/history agent — that
            hand off to each other mid-call instead of one assistant handling everything.
            Callers hear one continuous conversation; nothing changes about your phone number
            or voice.
          </p>

          <label className="mt-4 flex items-center gap-3">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => handleToggle(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
            />
            <span className="text-sm font-medium text-slate-700">
              Use specialized agents (Router / Scheduler / Emergency / Pricing / Account)
            </span>
          </label>

          {dirty && (
            <button
              onClick={handleSave}
              disabled={saving}
              className="mt-4 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

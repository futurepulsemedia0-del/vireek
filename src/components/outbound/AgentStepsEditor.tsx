import { useEffect, useState } from 'react';
import { Phone, MessageSquare, Plus, Trash2, ChevronDown, ChevronUp } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { supabase, type FollowupAgentStep, type FollowupAgentStepChannel } from '@/lib/supabase';
import type { OutboundCampaignType } from '@/lib/outboundCampaigns';

// ============================================================
// TYPES
// ============================================================

interface DraftStep {
  channel: FollowupAgentStepChannel;
  delay_hours: number;
  sms_body: string;
  call_context: string;
}

interface AgentStepsEditorProps {
  userId: string;
  campaignType: OutboundCampaignType;
  /** e.g. "hours after the quote is sent" — reused from OUTBOUND_CAMPAIGNS.triggerLabel wording */
  firstStepHint: string;
}

const MAX_STEPS = 5;

const SMS_TOKEN_HINT = '{{customer_name}} · {{business_name}} · {{quote_amount}} · {{appointment_time}} · {{review_link}}';

function emptyStep(channel: FollowupAgentStepChannel = 'sms'): DraftStep {
  return { channel, delay_hours: 24, sms_body: '', call_context: '' };
}

function toDraft(step: FollowupAgentStep): DraftStep {
  return {
    channel: step.channel,
    delay_hours: step.delay_hours,
    sms_body: step.sms_body ?? '',
    call_context: step.call_context ?? '',
  };
}

// ============================================================
// COMPONENT
// ============================================================

export function AgentStepsEditor({ userId, campaignType, firstStepHint }: AgentStepsEditorProps) {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [steps, setSteps] = useState<DraftStep[]>([]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      const { data, error } = await supabase
        .from('followup_agent_steps')
        .select('*')
        .eq('campaign_type', campaignType)
        .order('step_number', { ascending: true });

      if (!cancelled) {
        if (!error && data) {
          setSteps((data as FollowupAgentStep[]).map(toDraft));
        }
        setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [campaignType]);

  const addStep = () => {
    if (steps.length >= MAX_STEPS) return;
    setSteps((prev) => [...prev, emptyStep(prev.length % 2 === 0 ? 'sms' : 'call')]);
    setExpanded(true);
  };

  const removeStep = (index: number) => {
    setSteps((prev) => prev.filter((_, i) => i !== index));
  };

  const updateStep = (index: number, patch: Partial<DraftStep>) => {
    setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  };

  const handleSave = async () => {
    for (const step of steps) {
      if (step.channel === 'sms' && !step.sms_body.trim()) {
        toast('Every text step needs a message before you can save', 'error');
        return;
      }
    }

    setSaving(true);

    // Simplest consistent approach for a small, infrequently-edited list:
    // replace the whole sequence for this campaign type rather than trying
    // to diff/renumber individual rows against the (step_number) unique
    // constraint.
    const { error: deleteError } = await supabase
      .from('followup_agent_steps')
      .delete()
      .eq('campaign_type', campaignType);

    if (deleteError) {
      setSaving(false);
      toast('Could not save the agent sequence', 'error');
      return;
    }

    if (steps.length > 0) {
      const rows = steps.map((step, i) => ({
        user_id: userId,
        campaign_type: campaignType,
        step_number: i + 1,
        channel: step.channel,
        delay_hours: step.delay_hours,
        sms_body: step.channel === 'sms' ? step.sms_body.trim() : null,
        call_context: step.channel === 'call' ? step.call_context.trim() || null : null,
      }));

      const { error: insertError } = await supabase.from('followup_agent_steps').insert(rows);
      if (insertError) {
        setSaving(false);
        toast('Could not save the agent sequence', 'error');
        return;
      }
    }

    setSaving(false);
    toast(steps.length > 0 ? 'Agent sequence saved' : 'Reverted to a single follow-up call', 'success');
  };

  if (loading) {
    return <div className="mt-4 h-10 animate-pulse rounded-xl bg-bg-tertiary" />;
  }

  return (
    <div className="mt-5 border-t border-border/60 pt-4">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="focus-ring flex w-full items-center justify-between gap-2 text-left text-xs font-semibold text-text-primary"
      >
        <span>
          Agent sequence{' '}
          <span className="font-normal text-text-secondary">
            ({steps.length === 0 ? 'single call, default timing' : `${steps.length} step${steps.length === 1 ? '' : 's'}`})
          </span>
        </span>
        {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>

      {expanded && (
        <div className="mt-4 space-y-3">
          <p className="text-xs leading-relaxed text-text-secondary">
            Build a multi-step sequence — mix texts and calls, each fired a set number of hours after the one
            before it (the first step's delay is {firstStepHint}). The sequence stops itself automatically the
            moment it's no longer needed (lead booked, appointment changed, review already left, or the customer
            replies STOP).
          </p>

          {steps.length === 0 && (
            <p className="rounded-xl border border-dashed border-border px-4 py-3 text-xs text-text-secondary">
              No sequence configured — this campaign still runs as a single follow-up call, using the timing set
              above. Add a step to turn it into a multi-step agent.
            </p>
          )}

          {steps.map((step, index) => (
            <div key={index} className="rounded-xl border border-border bg-bg-primary p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent/10 text-[11px] font-semibold text-accent">
                    {index + 1}
                  </span>
                  <div className="flex overflow-hidden rounded-lg border border-border">
                    <button
                      type="button"
                      onClick={() => updateStep(index, { channel: 'sms' })}
                      className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors ${
                        step.channel === 'sms' ? 'bg-accent text-white' : 'bg-bg-secondary text-text-secondary'
                      }`}
                    >
                      <MessageSquare size={13} /> Text
                    </button>
                    <button
                      type="button"
                      onClick={() => updateStep(index, { channel: 'call' })}
                      className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors ${
                        step.channel === 'call' ? 'bg-accent text-white' : 'bg-bg-secondary text-text-secondary'
                      }`}
                    >
                      <Phone size={13} /> Call
                    </button>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => removeStep(index)}
                  className="focus-ring rounded-lg p-1.5 text-text-secondary hover:text-danger"
                  aria-label={`Remove step ${index + 1}`}
                >
                  <Trash2 size={14} />
                </button>
              </div>

              <label className="mt-3 flex items-center gap-2 text-xs text-text-secondary">
                {index === 0 ? firstStepHint : 'Then wait'}
                <input
                  type="number"
                  min={0}
                  value={step.delay_hours}
                  onChange={(e) => updateStep(index, { delay_hours: Number(e.target.value) })}
                  className="w-16 rounded-lg border border-border bg-bg-secondary px-2 py-1 text-center text-xs text-text-primary focus-ring"
                />
                hours{index > 0 ? ' after the step before it' : ''}
              </label>

              {step.channel === 'sms' ? (
                <div className="mt-3">
                  <textarea
                    value={step.sms_body}
                    onChange={(e) => updateStep(index, { sms_body: e.target.value })}
                    rows={2}
                    placeholder="Hi {{customer_name}}, following up on your quote from {{business_name}}…"
                    className="w-full rounded-lg border border-border bg-bg-secondary px-3 py-2 text-xs text-text-primary focus-ring"
                  />
                  <p className="mt-1 text-[11px] text-text-secondary/70">Available: {SMS_TOKEN_HINT}</p>
                </div>
              ) : (
                <div className="mt-3">
                  <textarea
                    value={step.call_context}
                    onChange={(e) => updateStep(index, { call_context: e.target.value })}
                    rows={2}
                    placeholder="Optional — extra instruction for Sarah on this call, e.g. mention the financing offer"
                    className="w-full rounded-lg border border-border bg-bg-secondary px-3 py-2 text-xs text-text-primary focus-ring"
                  />
                  <p className="mt-1 text-[11px] text-text-secondary/70">
                    Only reaches the live call if your Vapi assistant prompt reads the follow-up context variable —
                    see Business Profile → Assistant configuration.
                  </p>
                </div>
              )}
            </div>
          ))}

          <div className="flex items-center justify-between gap-3 pt-1">
            <button
              type="button"
              onClick={addStep}
              disabled={steps.length >= MAX_STEPS}
              className="focus-ring flex items-center gap-1.5 rounded-lg border border-dashed border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:border-accent/50 hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus size={13} /> Add step{steps.length >= MAX_STEPS ? ' (max 5)' : ''}
            </button>

            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="focus-ring rounded-lg bg-accent px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
            >
              {saving ? 'Saving…' : 'Save sequence'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

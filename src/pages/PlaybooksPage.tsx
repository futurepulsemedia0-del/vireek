import { useEffect, useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  BookMarked,
  Lock,
  Check,
  ChevronDown,
  ChevronUp,
  Sparkles,
  ShieldAlert,
  ListChecks,
  Wrench,
  TrendingUp,
  Copy,
  ExternalLink,
  History,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import {
  PLAYBOOKS,
  applyPlaybook,
  fetchPlaybookState,
  relativePlaybookTime,
  type Playbook,
  type PlaybookState,
} from '@/lib/playbooks';
import { SkeletonCardList, FadeIn } from '@/components/Skeleton';

function PlaybookCard({
  playbook,
  isActive,
  isExpanded,
  onToggleExpand,
  onApply,
  applying,
}: {
  playbook: Playbook;
  isActive: boolean;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onApply: () => void;
  applying: boolean;
}) {
  const { toast } = useToast();

  const handleCopyGreeting = () => {
    navigator.clipboard.writeText(playbook.suggestedGreeting).then(
      () => toast('Greeting copied — paste it into Assistant settings.', 'success'),
      () => toast('Could not copy to clipboard.', 'error'),
    );
  };

  return (
    <div className={`rounded-2xl border p-5 shadow-card transition-colors dark:shadow-card-dark ${isActive ? 'border-accent bg-accent/5' : 'border-border bg-bg-secondary'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${isActive ? 'bg-accent text-white' : 'bg-accent/10 text-accent'}`}>
            <BookMarked size={18} />
          </span>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-text-primary">{playbook.name}</h3>
              {isActive && (
                <span className="flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent">
                  <Check size={11} /> Active
                </span>
              )}
            </div>
            <p className="mt-0.5 text-xs text-text-secondary">{playbook.tagline}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={onToggleExpand}
          className="focus-ring flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
          aria-label={isExpanded ? 'Collapse details' : 'Expand details'}
        >
          {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
      </div>

      <div className="mt-3 flex flex-wrap gap-3 text-[11px] text-text-secondary">
        <span>{playbook.articles.length} knowledge articles</span>
        <span>·</span>
        <span>{playbook.commonServices.length} services</span>
        <span>·</span>
        <span>{playbook.emergencyKeywords.length} emergency triggers</span>
      </div>

      {isExpanded && (
        <div className="mt-4 space-y-4 border-t border-border/60 pt-4">
          <div>
            <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-text-primary">
              <ListChecks size={13} /> Triage questions
            </p>
            <ul className="space-y-1 text-xs text-text-secondary">
              {playbook.triageQuestions.map((q) => (
                <li key={q}>&bull; {q}</li>
              ))}
            </ul>
          </div>

          <div>
            <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-danger">
              <ShieldAlert size={13} /> Emergency guidance
            </p>
            <p className="text-xs leading-relaxed text-text-secondary">{playbook.emergencyGuidance}</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {playbook.emergencyKeywords.map((k) => (
                <span key={k} className="rounded-full bg-danger/10 px-2 py-0.5 text-[11px] text-danger">
                  {k}
                </span>
              ))}
            </div>
          </div>

          <div>
            <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-text-primary">
              <Wrench size={13} /> Common services
            </p>
            <div className="flex flex-wrap gap-1.5">
              {playbook.commonServices.map((s) => (
                <span key={s} className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] text-text-secondary">
                  {s}
                </span>
              ))}
            </div>
          </div>

          <div>
            <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-text-primary">
              <TrendingUp size={13} /> Upsell prompts
            </p>
            <ul className="space-y-1 text-xs text-text-secondary">
              {playbook.upsellPrompts.map((u) => (
                <li key={u}>&bull; {u}</li>
              ))}
            </ul>
          </div>

          <div>
            <p className="mb-1.5 text-xs font-semibold text-text-primary">Suggested greeting</p>
            <div className="flex items-start justify-between gap-2 rounded-xl border border-border bg-bg-primary p-3">
              <p className="text-xs italic leading-relaxed text-text-secondary">&ldquo;{playbook.suggestedGreeting}&rdquo;</p>
              <button
                type="button"
                onClick={handleCopyGreeting}
                className="focus-ring flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                aria-label="Copy greeting"
              >
                <Copy size={13} />
              </button>
            </div>
            <p className="mt-1 text-[11px] text-text-secondary">Not applied automatically — copy it into Assistant settings if you want to use it.</p>
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={onApply}
        disabled={applying}
        className={`focus-ring mt-4 flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition-colors disabled:opacity-50 ${
          isActive
            ? 'border border-border bg-bg-secondary text-text-primary hover:bg-bg-tertiary'
            : 'bg-accent text-white hover:bg-accent/90'
        }`}
      >
        <Sparkles size={15} />
        {applying ? 'Applying…' : isActive ? 'Re-apply playbook' : 'Apply this playbook'}
      </button>
    </div>
  );
}

export function PlaybooksPage() {
  const navigate = useNavigate();
  const { user, isOwner, permissions } = useAuth();
  const { toast } = useToast();

  const canAccess = isOwner || permissions.can_edit_business_profile;

  const [state, setState] = useState<PlaybookState | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedSlug, setExpandedSlug] = useState<string | null>(null);
  const [applyingSlug, setApplyingSlug] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const loadState = useCallback(async () => {
    if (!user || !canAccess) return;
    setLoading(true);
    try {
      const result = await fetchPlaybookState(user.id);
      setState(result);
    } catch {
      // empty state below handles this
    } finally {
      setLoading(false);
    }
  }, [user, canAccess]);

  useEffect(() => {
    loadState();
  }, [loadState]);

  const activePlaybook = useMemo(
    () => PLAYBOOKS.find((p) => p.slug === state?.activePlaybookSlug) ?? null,
    [state],
  );

  const handleApply = async (playbook: Playbook) => {
    if (!user) return;
    setApplyingSlug(playbook.slug);
    try {
      const result = await applyPlaybook(playbook, user.id);
      toast(
        `${playbook.name} playbook applied — ${result.articlesCreated} knowledge articles created.`,
        'success',
      );
      await loadState();
    } catch {
      toast('Could not apply this playbook. Please try again.', 'error');
    } finally {
      setApplyingSlug(null);
    }
  };

  if (!canAccess) {
    return (
      <DashboardLayout activeLabel="Playbooks">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
            <Lock size={26} />
          </span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">
            AI Playbooks access is restricted. Ask your account owner to grant you the "Edit Business Profile" permission.
          </p>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel="Playbooks">
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigate('/dashboard')}
            className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-bg-secondary text-text-secondary transition-colors hover:text-text-primary"
            aria-label="Back to dashboard"
          >
            <ArrowLeft size={18} />
          </button>
          <div>
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent">
                <BookMarked size={16} />
              </span>
              <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">AI Playbooks</h1>
            </div>
            <p className="mt-1 text-sm text-text-secondary">Trade-specific triage, emergency handling and upsells for your AI receptionist</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => navigate('/dashboard/knowledge')}
          className="focus-ring flex items-center justify-center gap-2 rounded-xl border border-border bg-bg-secondary px-4 py-2.5 text-sm font-medium text-text-primary transition-colors hover:bg-bg-tertiary"
        >
          <ExternalLink size={15} />
          View Knowledge Base
        </button>
      </div>

      {loading ? (
        <SkeletonCardList count={6} rows={3} />
      ) : (
        <FadeIn>
          {activePlaybook && (
            <div className="mb-6 flex items-start gap-3 rounded-2xl border border-accent/30 bg-accent/5 p-4">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent text-white">
                <Check size={16} />
              </span>
              <div>
                <p className="text-sm font-semibold text-text-primary">{activePlaybook.name} playbook is active</p>
                <p className="text-xs text-text-secondary">
                  Applied {relativePlaybookTime(state?.activePlaybookAppliedAt ?? null)} — your AI receptionist is using its
                  knowledge articles on live calls right now.
                </p>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {PLAYBOOKS.map((playbook) => (
              <PlaybookCard
                key={playbook.slug}
                playbook={playbook}
                isActive={playbook.slug === state?.activePlaybookSlug}
                isExpanded={expandedSlug === playbook.slug}
                onToggleExpand={() => setExpandedSlug(expandedSlug === playbook.slug ? null : playbook.slug)}
                onApply={() => handleApply(playbook)}
                applying={applyingSlug === playbook.slug}
              />
            ))}
          </div>

          {state && state.history.length > 0 && (
            <div className="mt-6 rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark">
              <button
                type="button"
                onClick={() => setShowHistory(!showHistory)}
                className="focus-ring flex w-full items-center justify-between gap-2 text-left"
              >
                <span className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                  <History size={15} /> Application history
                </span>
                {showHistory ? <ChevronUp size={16} className="text-text-secondary" /> : <ChevronDown size={16} className="text-text-secondary" />}
              </button>
              {showHistory && (
                <div className="mt-3 space-y-1.5">
                  {state.history.map((h) => {
                    const p = PLAYBOOKS.find((pb) => pb.slug === h.playbook_slug);
                    return (
                      <div key={h.id} className="flex items-center justify-between rounded-xl border border-border/60 px-3 py-2 text-xs">
                        <span className="text-text-primary">{p?.name ?? h.playbook_slug}</span>
                        <span className="text-text-secondary">
                          {h.articles_created} articles · {relativePlaybookTime(h.applied_at)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          <div className="mt-6 flex items-start gap-2 rounded-xl border border-dashed border-border p-4">
            <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-text-secondary" />
            <p className="text-xs leading-relaxed text-text-secondary">
              Applying a playbook publishes real articles into your Knowledge Base (source: &ldquo;playbook&rdquo;) that
              your AI receptionist searches on every call — it doesn't just decorate this page. It never overwrites
              services or a greeting script you've already customized; services are merged in, and the suggested
              greeting is copy-only. You can review, edit, or archive any generated article from the Knowledge Base
              page like any other.
            </p>
          </div>
        </FadeIn>
      )}
    </DashboardLayout>
  );
}

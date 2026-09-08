import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Phone,
  ArrowLeft,
  Search,
  X,
  Plus,
  Mail,
  User,
  Wrench,
  ArrowRight,
  GripVertical,
  Trash2,
  Phone as PhoneIcon,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { supabase, Lead, Call } from '@/lib/supabase';
import { useKeyboardShortcut } from '@/lib/hooks';

// ============================================================
// TYPES
// ============================================================

type Stage = Lead['stage'];

const STAGES: { key: Stage; label: string; color: string; dotColor: string }[] = [
  { key: 'new', label: 'New', color: 'border-t-accent', dotColor: 'bg-accent' },
  { key: 'contacted', label: 'Contacted', color: 'border-t-blue-500', dotColor: 'bg-blue-500' },
  { key: 'quoted', label: 'Quoted', color: 'border-t-warning-500', dotColor: 'bg-warning-500' },
  { key: 'won', label: 'Won', color: 'border-t-success-500', dotColor: 'bg-success-500' },
  { key: 'lost', label: 'Lost', color: 'border-t-danger', dotColor: 'bg-danger' },
];

// ============================================================
// HELPERS
// ============================================================

function formatTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  const mins = Math.floor(diff / 60000);
  return mins > 0 ? `${mins}m ago` : 'just now';
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
// SHARED UI
// ============================================================

function SkeletonBlock({ className }: { className: string }) {
  return <div className={`animate-pulse rounded bg-bg-tertiary ${className}`} />;
}

// ============================================================
// LEAD CARD (Kanban)
// ============================================================

function LeadCard({
  lead,
  onClick,
  onDragStart,
  onDragEnd,
  isDragging,
}: {
  lead: Lead;
  onClick: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: (e: React.DragEvent) => void;
  isDragging: boolean;
}) {
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onClick}
      className={`group cursor-pointer rounded-xl border border-border bg-bg-primary p-3.5 shadow-sm transition-all hover:border-accent/40 hover:shadow-card ${
        isDragging ? 'opacity-40' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-text-primary truncate">{lead.name}</p>
          {lead.service_interested && (
            <p className="mt-0.5 text-xs text-text-secondary truncate">{lead.service_interested}</p>
          )}
        </div>
        <GripVertical size={14} className="mt-0.5 shrink-0 text-text-secondary/40 opacity-0 group-hover:opacity-100" />
      </div>
      <div className="mt-2 flex items-center gap-2 text-xs text-text-secondary">
        {lead.phone && (
          <span className="flex items-center gap-1">
            <PhoneIcon size={11} /> {lead.phone}
          </span>
        )}
        <span className="ml-auto">{formatTimeAgo(lead.created_at)}</span>
      </div>
    </div>
  );
}

// ============================================================
// LEAD DETAIL PANEL
// ============================================================

function LeadDetailPanel({
  lead,
  originatingCall,
  onClose,
  onUpdateNotes,
  onUpdateStage,
  onConvertToJob,
  onDelete,
}: {
  lead: Lead;
  originatingCall: Call | null;
  onClose: () => void;
  onUpdateNotes: (notes: string) => void;
  onUpdateStage: (stage: Stage) => void;
  onConvertToJob: () => void;
  onDelete: () => void;
}) {
  const [notes, setNotes] = useState(lead.notes ?? '');
  const [editingNotes, setEditingNotes] = useState(false);
  const notesRef = useRef<HTMLTextAreaElement>(null);

  const saveNotes = () => {
    setEditingNotes(false);
    if (notes !== (lead.notes ?? '')) {
      onUpdateNotes(notes);
    }
  };

  return (
    <motion.div
      initial={{ x: '100%' }}
      animate={{ x: 0 }}
      exit={{ x: '100%' }}
      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      className="fixed right-0 top-0 z-50 h-full w-full max-w-md overflow-y-auto border-l border-border bg-bg-secondary shadow-card-hover dark:shadow-card-hover-dark"
    >
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-bg-secondary/95 px-6 py-4 backdrop-blur-md">
        <h2 className="text-base font-semibold text-text-primary">Lead Details</h2>
        <button
          type="button"
          onClick={onClose}
          className="focus-ring flex h-9 w-9 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
          aria-label="Close panel"
        >
          <X size={18} />
        </button>
      </div>

      <div className="px-6 py-5 space-y-5">
        {/* Name + stage */}
        <div>
          <h3 className="text-xl font-bold text-text-primary">{lead.name}</h3>
          <div className="mt-2 flex flex-wrap gap-2">
            {STAGES.map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => onUpdateStage(s.key)}
                className={`focus-ring rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  lead.stage === s.key
                    ? `${s.dotColor} text-white`
                    : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        {/* Contact info */}
        <div className="grid gap-2">
          {lead.phone && (
            <a
              href={`tel:${lead.phone}`}
              className="focus-ring flex items-center gap-3 rounded-xl border border-border bg-bg-primary p-3 text-sm text-text-primary transition-colors hover:border-accent/40"
            >
              <Phone size={16} className="text-accent" />
              {lead.phone}
            </a>
          )}
          {lead.email && (
            <a
              href={`mailto:${lead.email}`}
              className="focus-ring flex items-center gap-3 rounded-xl border border-border bg-bg-primary p-3 text-sm text-text-primary transition-colors hover:border-accent/40"
            >
              <Mail size={16} className="text-accent" />
              {lead.email}
            </a>
          )}
          {lead.service_interested && (
            <div className="flex items-center gap-3 rounded-xl border border-border bg-bg-primary p-3 text-sm text-text-primary">
              <Wrench size={16} className="text-accent" />
              {lead.service_interested}
            </div>
          )}
        </div>

        {/* Originating call */}
        {originatingCall && (
          <div>
            <p className="mb-2 text-xs font-medium text-text-secondary">Originating Call</p>
            <div className="rounded-xl border border-border bg-bg-primary p-4">
              <div className="flex items-center gap-2">
                <Phone size={14} className="text-accent" />
                <span className="text-sm font-medium text-text-primary">{originatingCall.caller_name || 'Unknown'}</span>
                <span className="ml-auto text-xs text-text-secondary">{formatDateTime(originatingCall.call_datetime)}</span>
              </div>
              {originatingCall.summary && (
                <p className="mt-2 text-sm leading-relaxed text-text-secondary line-clamp-3">{originatingCall.summary}</p>
              )}
            </div>
          </div>
        )}

        {/* Notes */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-medium text-text-secondary">Notes</p>
            {!editingNotes && (
              <button
                type="button"
                onClick={() => {
                  setEditingNotes(true);
                  setTimeout(() => notesRef.current?.focus(), 50);
                }}
                className="focus-ring text-xs text-accent hover:underline"
              >
                Edit
              </button>
            )}
          </div>
          {editingNotes ? (
            <div className="space-y-2">
              <textarea
                ref={notesRef}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={4}
                className="focus-ring w-full rounded-xl border border-border bg-bg-primary p-3 text-sm text-text-primary"
                placeholder="Add notes about this lead…"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={saveNotes}
                  className="focus-ring rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setNotes(lead.notes ?? '');
                    setEditingNotes(false);
                  }}
                  className="focus-ring rounded-lg border border-border px-4 py-2 text-sm text-text-secondary hover:text-text-primary"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-border bg-bg-primary p-4 text-sm leading-relaxed text-text-primary min-h-[60px]">
              {notes || <span className="text-text-secondary/60">No notes yet. Click Edit to add notes.</span>}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="space-y-2 border-t border-border pt-4">
          <button
            type="button"
            onClick={onConvertToJob}
            className="focus-ring flex w-full items-center justify-center gap-2 rounded-xl bg-cta px-4 py-3 text-sm font-semibold text-white shadow-sm transition-all hover:brightness-110 hover:shadow-glow-cta"
          >
            <Wrench size={16} />
            Convert to Job
            <ArrowRight size={14} />
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="focus-ring flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-bg-primary px-4 py-3 text-sm font-medium text-text-secondary transition-colors hover:border-danger/40 hover:text-danger"
          >
            <Trash2 size={16} />
            Delete Lead
          </button>
        </div>
      </div>
    </motion.div>
  );
}

// ============================================================
// MAIN LEADS PAGE
// ============================================================

export function LeadsPage() {
  const navigate = useNavigate();
  const { user, profile, profileLoading } = useAuth();
  const { toast } = useToast();

  const [allLeads, setAllLeads] = useState<Lead[]>([]);
  const [allCalls, setAllCalls] = useState<Call[]>([]);
  const [dataLoading, setDataLoading] = useState(true);
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);
  const [search, setSearch] = useState('');
  const [mobileStage, setMobileStage] = useState<Stage | 'all'>('all');
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverStage, setDragOverStage] = useState<Stage | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);

  const loadData = useCallback(async () => {
    if (!user) return;
    setDataLoading(true);
    try {
      const [leadsRes, callsRes] = await Promise.all([
        supabase.from('leads').select('*').order('created_at', { ascending: false }),
        supabase.from('calls').select('*'),
      ]);
      if (leadsRes.data) setAllLeads(leadsRes.data as Lead[]);
      if (callsRes.data) setAllCalls(callsRes.data as Call[]);
    } catch {
      // empty states
    } finally {
      setDataLoading(false);
    }
  }, [user]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (!profileLoading && profile && !profile.onboarding_completed) {
      navigate('/onboarding', { replace: true });
    }
  }, [profile, profileLoading, navigate]);

  useKeyboardShortcut({
    key: '/',
    handler: () => searchRef.current?.focus(),
  });

  useKeyboardShortcut({
    key: 'Escape',
    handler: () => {
      if (selectedLead) {
        setSelectedLead(null);
      } else if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    },
  });

  const filteredLeads = useMemo(() => {
    if (!search.trim()) return allLeads;
    const q = search.toLowerCase();
    return allLeads.filter(
      (l) =>
        l.name.toLowerCase().includes(q) ||
        (l.phone?.toLowerCase().includes(q) ?? false) ||
        (l.email?.toLowerCase().includes(q) ?? false) ||
        (l.service_interested?.toLowerCase().includes(q) ?? false) ||
        (l.notes?.toLowerCase().includes(q) ?? false)
    );
  }, [allLeads, search]);

  const leadsByStage = useMemo(() => {
    const map: Record<Stage, Lead[]> = {
      new: [],
      contacted: [],
      quoted: [],
      won: [],
      lost: [],
    };
    filteredLeads.forEach((l) => {
      if (map[l.stage]) map[l.stage].push(l);
    });
    return map;
  }, [filteredLeads]);

  const mobileFilteredLeads = useMemo(() => {
    if (mobileStage === 'all') return filteredLeads;
    return filteredLeads.filter((l) => l.stage === mobileStage);
  }, [filteredLeads, mobileStage]);

  const handleDragStart = (e: React.DragEvent, lead: Lead) => {
    setDraggingId(lead.id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', lead.id);
  };

  const handleDragEnd = () => {
    setDraggingId(null);
    setDragOverStage(null);
  };

  const handleDragOver = (e: React.DragEvent, stage: Stage) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverStage(stage);
  };

  const handleDrop = async (e: React.DragEvent, stage: Stage) => {
    e.preventDefault();
    const leadId = e.dataTransfer.getData('text/plain');
    setDraggingId(null);
    setDragOverStage(null);
    if (!leadId) return;

    const lead = allLeads.find((l) => l.id === leadId);
    if (!lead || lead.stage === stage) return;

    try {
      const { error } = await supabase.from('leads').update({ stage }).eq('id', leadId);
      if (error) throw error;
      setAllLeads((prev) => prev.map((l) => (l.id === leadId ? { ...l, stage } : l)));
      if (selectedLead?.id === leadId) {
        setSelectedLead((prev) => (prev ? { ...prev, stage } : null));
      }
      toast(`Lead moved to ${STAGES.find((s) => s.key === stage)?.label}.`, 'success');
    } catch {
      toast('Could not update lead stage.', 'error');
    }
  };

  const handleUpdateNotes = async (notes: string) => {
    if (!selectedLead) return;
    try {
      const { error } = await supabase.from('leads').update({ notes }).eq('id', selectedLead.id);
      if (error) throw error;
      setAllLeads((prev) => prev.map((l) => (l.id === selectedLead.id ? { ...l, notes } : l)));
      setSelectedLead((prev) => (prev ? { ...prev, notes } : null));
      toast('Notes saved.', 'success');
    } catch {
      toast('Could not save notes.', 'error');
    }
  };

  const handleUpdateStage = async (stage: Stage) => {
    if (!selectedLead) return;
    try {
      const { error } = await supabase.from('leads').update({ stage }).eq('id', selectedLead.id);
      if (error) throw error;
      setAllLeads((prev) => prev.map((l) => (l.id === selectedLead.id ? { ...l, stage } : l)));
      setSelectedLead((prev) => (prev ? { ...prev, stage } : null));
      toast(`Lead moved to ${STAGES.find((s) => s.key === stage)?.label}.`, 'success');
    } catch {
      toast('Could not update lead stage.', 'error');
    }
  };

  const handleDelete = async () => {
    if (!selectedLead) return;
    try {
      const { error } = await supabase.from('leads').delete().eq('id', selectedLead.id);
      if (error) throw error;
      setAllLeads((prev) => prev.filter((l) => l.id !== selectedLead.id));
      setSelectedLead(null);
      toast('Lead deleted.', 'success');
    } catch {
      toast('Could not delete lead.', 'error');
    }
  };

  const handleConvertToJob = () => {
    if (!selectedLead) return;
    navigate('/dashboard/jobs', {
      state: {
        prefill: {
          customer_name: selectedLead.name,
          service_type: selectedLead.service_interested ?? '',
          lead_id: selectedLead.id,
          call_id: selectedLead.call_id ?? undefined,
        },
      },
    });
  };

  const originatingCall = selectedLead?.call_id
    ? allCalls.find((c) => c.id === selectedLead.call_id) ?? null
    : null;

  return (
    <DashboardLayout activeLabel="Leads">
      {/* Page header */}
        <div className="mb-6 flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigate('/dashboard')}
            className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-bg-secondary text-text-secondary transition-colors hover:text-text-primary"
            aria-label="Back to dashboard"
          >
            <ArrowLeft size={18} />
          </button>
          <div className="flex-1">
            <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">Leads</h1>
            <p className="mt-1 text-sm text-text-secondary">
              {filteredLeads.length} {filteredLeads.length === 1 ? 'lead' : 'leads'}
              {search && ' (filtered)'}
            </p>
          </div>
          <div className="relative flex-1 max-w-xs">
            <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-text-secondary" />
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search leads…  (press /)"
              className="focus-ring w-full rounded-xl border border-border bg-bg-secondary py-2.5 pl-10 pr-4 text-sm text-text-primary placeholder:text-text-secondary/60"
            />
          </div>
        </div>

        {dataLoading ? (
          // Skeleton
          <div className="grid gap-4 lg:grid-cols-5">
            {STAGES.map((s) => (
              <div key={s.key} className="rounded-2xl border border-border bg-bg-secondary p-4 shadow-card dark:shadow-card-dark">
                <SkeletonBlock className="h-5 w-20" />
                <div className="mt-4 space-y-3">
                  {Array.from({ length: 2 }).map((_, i) => (
                    <SkeletonBlock key={i} className="h-20 w-full" />
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : filteredLeads.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-16 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
              <User size={26} />
            </span>
            <h3 className="mt-4 text-base font-semibold text-text-primary">
              {search ? 'No leads match your search' : 'No leads yet'}
            </h3>
            <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">
              {search
                ? 'Try a different search term.'
                : 'Leads from incoming calls will appear here. Drag cards between columns to update their stage.'}
            </p>
          </div>
        ) : (
          <>
            {/* Desktop Kanban */}
            <div className="hidden lg:grid lg:grid-cols-5 lg:gap-4">
              {STAGES.map((stage) => (
                <div
                  key={stage.key}
                  onDragOver={(e) => handleDragOver(e, stage.key)}
                  onDragLeave={() => setDragOverStage(null)}
                  onDrop={(e) => handleDrop(e, stage.key)}
                  className={`rounded-2xl border-t-4 ${stage.color} border-x border-b border-border bg-bg-secondary p-4 shadow-card transition-colors dark:shadow-card-dark ${
                    dragOverStage === stage.key ? 'ring-2 ring-accent/40' : ''
                  }`}
                >
                  <div className="mb-3 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className={`h-2.5 w-2.5 rounded-full ${stage.dotColor}`} />
                      <h2 className="text-sm font-semibold text-text-primary">{stage.label}</h2>
                    </div>
                    <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-xs font-medium text-text-secondary">
                      {leadsByStage[stage.key].length}
                    </span>
                  </div>
                  <div className="space-y-2.5 min-h-[100px]">
                    {leadsByStage[stage.key].map((lead) => (
                      <LeadCard
                        key={lead.id}
                        lead={lead}
                        onClick={() => setSelectedLead(lead)}
                        onDragStart={(e) => handleDragStart(e, lead)}
                        onDragEnd={handleDragEnd}
                        isDragging={draggingId === lead.id}
                      />
                    ))}
                    {leadsByStage[stage.key].length === 0 && (
                      <p className="py-4 text-center text-xs text-text-secondary/50">Drop leads here</p>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Mobile: stage filter + list */}
            <div className="lg:hidden">
              <div className="mb-4 flex gap-2 overflow-x-auto pb-1">
                <button
                  type="button"
                  onClick={() => setMobileStage('all')}
                  className={`focus-ring shrink-0 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                    mobileStage === 'all' ? 'bg-accent text-white' : 'bg-bg-secondary text-text-secondary border border-border'
                  }`}
                >
                  All ({filteredLeads.length})
                </button>
                {STAGES.map((s) => (
                  <button
                    key={s.key}
                    type="button"
                    onClick={() => setMobileStage(s.key)}
                    className={`focus-ring flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                      mobileStage === s.key ? `${s.dotColor} text-white` : 'bg-bg-secondary text-text-secondary border border-border'
                    }`}
                  >
                    <span className={`h-2 w-2 rounded-full ${mobileStage === s.key ? 'bg-white' : s.dotColor}`} />
                    {s.label} ({leadsByStage[s.key].length})
                  </button>
                ))}
              </div>
              <div className="space-y-3">
                {mobileFilteredLeads.map((lead) => (
                  <button
                    key={lead.id}
                    type="button"
                    onClick={() => setSelectedLead(lead)}
                    className="focus-ring w-full rounded-2xl border border-border bg-bg-secondary p-4 text-left shadow-card transition-colors hover:border-accent/40 dark:shadow-card-dark"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-semibold text-text-primary">{lead.name}</span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                          STAGES.find((s) => s.key === lead.stage)?.dotColor ?? 'bg-bg-tertiary'
                        } text-white`}
                      >
                        {STAGES.find((s) => s.key === lead.stage)?.label ?? lead.stage}
                      </span>
                    </div>
                    {lead.service_interested && (
                      <p className="mt-1 text-xs text-text-secondary">{lead.service_interested}</p>
                    )}
                    {lead.phone && (
                      <p className="mt-1 flex items-center gap-1 text-xs text-text-secondary">
                        <Phone size={11} /> {lead.phone}
                      </p>
                    )}
                    <p className="mt-1 text-xs text-text-secondary/70">{formatTimeAgo(lead.created_at)}</p>
                  </button>
                ))}
                {mobileFilteredLeads.length === 0 && (
                  <p className="py-8 text-center text-sm text-text-secondary">No leads in this stage.</p>
                )}
              </div>
            </div>
          </>
        )}
      {/* Detail panel */}
      <AnimatePresence>
        {selectedLead && (
          <>
            <div
              className="fixed inset-0 z-40 bg-black/20 backdrop-blur-sm"
              onClick={() => setSelectedLead(null)}
            />
            <LeadDetailPanel
              lead={selectedLead}
              originatingCall={originatingCall}
              onClose={() => setSelectedLead(null)}
              onUpdateNotes={handleUpdateNotes}
              onUpdateStage={handleUpdateStage}
              onConvertToJob={handleConvertToJob}
              onDelete={handleDelete}
            />
          </>
        )}
      </AnimatePresence>
    </DashboardLayout>
  );
}

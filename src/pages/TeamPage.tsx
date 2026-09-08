import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, X, Trash2, ShieldCheck, Mail, Check, Lock, Eye, CreditCard, Users, Settings, Wrench, Loader as Loader2, CircleUser as UserCircle } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { supabase, TeamMember } from '@/lib/supabase';
import { useKeyboardShortcut } from '@/lib/hooks';

// ============================================================
// TYPES & CONSTANTS
// ============================================================

type Role = 'admin' | 'technician' | 'member';

interface PermissionDef {
  key: 'can_view_billing' | 'can_manage_team' | 'can_edit_business_profile' | 'can_view_all_jobs';
  label: string;
  description: string;
  icon: typeof Eye;
}

const PERMISSIONS: PermissionDef[] = [
  { key: 'can_view_billing', label: 'View Billing', description: 'Access billing info and plan details', icon: CreditCard },
  { key: 'can_manage_team', label: 'Manage Team', description: 'Invite, edit, and remove team members', icon: Users },
  { key: 'can_edit_business_profile', label: 'Edit Business Profile', description: 'Modify services, hours, and FAQs', icon: Settings },
  { key: 'can_view_all_jobs', label: 'View All Jobs', description: 'See every job, not just assigned ones', icon: Wrench },
];

const ROLE_DEFAULTS: Record<Role, Record<PermissionDef['key'], boolean>> = {
  admin: { can_view_billing: true, can_manage_team: true, can_edit_business_profile: true, can_view_all_jobs: true },
  technician: { can_view_billing: false, can_manage_team: false, can_edit_business_profile: false, can_view_all_jobs: false },
  member: { can_view_billing: false, can_manage_team: false, can_edit_business_profile: false, can_view_all_jobs: true },
};

const ROLE_TAGS: Record<string, { label: string; color: string }> = {
  owner: { label: 'Owner', color: 'bg-accent/10 text-accent' },
  admin: { label: 'Admin', color: 'bg-blue-500/10 text-blue-500' },
  technician: { label: 'Technician', color: 'bg-warning-500/10 text-warning-500' },
  member: { label: 'Member', color: 'bg-bg-tertiary text-text-secondary' },
};

// ============================================================
// INVITE MODAL
// ============================================================

function InviteModal({
  onClose,
  onInvited,
}: {
  onClose: () => void;
  onInvited: () => void;
}) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [perms, setPerms] = useState(ROLE_DEFAULTS.member);
  const [submitting, setSubmitting] = useState(false);

  const handleRoleChange = (newRole: Role) => {
    setRole(newRole);
    setPerms(ROLE_DEFAULTS[newRole]);
  };

  const togglePerm = (key: PermissionDef['key']) => {
    setPerms((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !user) return;
    setSubmitting(true);
    const cleanEmail = email.trim().toLowerCase();
    try {
      const { error } = await supabase.from('team_members').insert({
        account_owner_id: user.id,
        member_email: cleanEmail,
        member_name: name.trim() || null,
        role,
        permissions: perms,
        invite_status: 'pending',
      });
      if (error) throw error;

      // The row is saved either way — the email is a courtesy on top of it,
      // so a failed send should never block adding the team member.
      const { error: emailError } = await supabase.functions.invoke('send-team-invite', {
        body: { memberEmail: cleanEmail, memberName: name.trim() || null, role },
      });

      if (emailError) {
        toast(
          `${cleanEmail} was added, but the invite email failed to send. Use "Resend invite" to try again.`,
          'info',
        );
      } else {
        toast(`Invitation email sent to ${cleanEmail}.`, 'success');
      }
      onInvited();
    } catch {
      toast('Could not add team member. Please try again.', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const inputClass =
    'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-2.5 text-base text-text-primary placeholder:text-text-secondary/60 sm:text-sm';

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
        className="relative w-full max-w-lg rounded-2xl border border-border bg-bg-secondary p-6 shadow-card-hover dark:shadow-card-hover-dark"
      >
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-bold text-text-primary">Invite Team Member</h2>
          <button
            type="button"
            onClick={onClose}
            className="focus-ring flex h-9 w-9 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-text-primary">Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Jane Doe"
                className={inputClass}
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-text-primary">
                Email <span className="text-cta">*</span>
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="jane@example.com"
                required
                className={inputClass}
              />
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-text-primary">Role</label>
            <div className="grid grid-cols-3 gap-2">
              {(['admin', 'technician', 'member'] as Role[]).map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => handleRoleChange(r)}
                  className={`focus-ring rounded-xl border px-3 py-2.5 text-sm font-medium capitalize transition-all ${
                    role === r
                      ? 'border-accent bg-accent/10 text-accent'
                      : 'border-border bg-bg-primary text-text-secondary hover:text-text-primary'
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>

          {/* Permissions checklist */}
          <div>
            <p className="mb-2 text-sm font-medium text-text-primary">Permissions</p>
            <div className="space-y-2">
              {PERMISSIONS.map((perm) => {
                const checked = perms[perm.key];
                return (
                  <button
                    key={perm.key}
                    type="button"
                    onClick={() => togglePerm(perm.key)}
                    className={`focus-ring flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors ${
                      checked
                        ? 'border-accent/30 bg-accent/5'
                        : 'border-border bg-bg-primary hover:bg-bg-tertiary/50'
                    }`}
                  >
                    <span
                      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition-colors ${
                        checked ? 'border-accent bg-accent text-white' : 'border-border bg-bg-tertiary'
                      }`}
                    >
                      {checked && <Check size={13} />}
                    </span>
                    <perm.icon size={16} className={checked ? 'text-accent' : 'text-text-secondary'} />
                    <div className="flex-1">
                      <p className={`text-sm font-medium ${checked ? 'text-text-primary' : 'text-text-secondary'}`}>
                        {perm.label}
                      </p>
                      <p className="text-xs text-text-secondary/70">{perm.description}</p>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex items-center gap-3 pt-2">
            <button
              type="submit"
              disabled={submitting || !email.trim()}
              className="focus-ring flex flex-1 items-center justify-center gap-2 rounded-xl bg-cta px-4 py-3 text-sm font-semibold text-white transition-all hover:brightness-110 disabled:opacity-50"
            >
              {submitting ? <Loader2 size={16} className="animate-spin" /> : <Mail size={16} />}
              {submitting ? 'Sending…' : 'Send Invitation'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="focus-ring rounded-xl border border-border px-4 py-3 text-sm font-medium text-text-secondary hover:text-text-primary"
            >
              Cancel
            </button>
          </div>
        </form>
      </motion.div>
    </div>
  );
}

// ============================================================
// EDIT PERMISSIONS MODAL
// ============================================================

function EditModal({
  member,
  onClose,
  onSaved,
}: {
  member: TeamMember;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [role, setRole] = useState<Role>(member.role === 'owner' ? 'admin' : member.role);
  const [perms, setPerms] = useState(member.permissions);
  const [saving, setSaving] = useState(false);

  const handleRoleChange = (newRole: Role) => {
    setRole(newRole);
    setPerms(ROLE_DEFAULTS[newRole]);
  };

  const togglePerm = (key: PermissionDef['key']) => {
    setPerms((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const { error } = await supabase
        .from('team_members')
        .update({ role, permissions: perms })
        .eq('id', member.id);
      if (error) throw error;
      toast('Team member updated.', 'success');
      onSaved();
    } catch {
      toast('Could not update team member.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
        className="relative w-full max-w-lg rounded-2xl border border-border bg-bg-secondary p-6 shadow-card-hover dark:shadow-card-hover-dark"
      >
        <div className="mb-5 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-text-primary">Edit Member</h2>
            <p className="mt-0.5 text-sm text-text-secondary">{member.member_name ?? member.member_email}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="focus-ring flex h-9 w-9 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-text-primary">Role</label>
            <div className="grid grid-cols-3 gap-2">
              {(['admin', 'technician', 'member'] as Role[]).map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => handleRoleChange(r)}
                  className={`focus-ring rounded-xl border px-3 py-2.5 text-sm font-medium capitalize transition-all ${
                    role === r
                      ? 'border-accent bg-accent/10 text-accent'
                      : 'border-border bg-bg-primary text-text-secondary hover:text-text-primary'
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="mb-2 text-sm font-medium text-text-primary">Permissions</p>
            <div className="space-y-2">
              {PERMISSIONS.map((perm) => {
                const checked = perms[perm.key];
                return (
                  <button
                    key={perm.key}
                    type="button"
                    onClick={() => togglePerm(perm.key)}
                    className={`focus-ring flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors ${
                      checked
                        ? 'border-accent/30 bg-accent/5'
                        : 'border-border bg-bg-primary hover:bg-bg-tertiary/50'
                    }`}
                  >
                    <span
                      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition-colors ${
                        checked ? 'border-accent bg-accent text-white' : 'border-border bg-bg-tertiary'
                      }`}
                    >
                      {checked && <Check size={13} />}
                    </span>
                    <perm.icon size={16} className={checked ? 'text-accent' : 'text-text-secondary'} />
                    <div className="flex-1">
                      <p className={`text-sm font-medium ${checked ? 'text-text-primary' : 'text-text-secondary'}`}>
                        {perm.label}
                      </p>
                      <p className="text-xs text-text-secondary/70">{perm.description}</p>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex items-center gap-3 pt-2">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="focus-ring flex flex-1 items-center justify-center gap-2 rounded-xl bg-cta px-4 py-3 text-sm font-semibold text-white transition-all hover:brightness-110 disabled:opacity-50"
            >
              {saving ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
              {saving ? 'Saving…' : 'Save Changes'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="focus-ring rounded-xl border border-border px-4 py-3 text-sm font-medium text-text-secondary hover:text-text-primary"
            >
              Cancel
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

// ============================================================
// MY PERMISSIONS CARD
// ============================================================

function MyPermissionsCard() {
  const { permissions, isOwner, teamMember } = useAuth();

  if (isOwner) return null;

  const permEntries: { perm: PermissionDef; granted: boolean }[] = PERMISSIONS.map((perm) => ({
    perm,
    granted: permissions[perm.key],
  }));

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark"
    >
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
          <ShieldCheck size={20} />
        </span>
        <div>
          <h3 className="text-sm font-semibold text-text-primary">Your Access</h3>
          <p className="text-xs text-text-secondary">
            {teamMember && (
              <span className="mr-1.5 inline-flex rounded-full bg-bg-tertiary px-2 py-0.5 text-xs font-medium capitalize">
                {teamMember.role}
              </span>
            )}
            Here's what you can and can't do in this account.
          </p>
        </div>
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {permEntries.map(({ perm, granted }) => (
          <div
            key={perm.key}
            className={`flex items-center gap-2.5 rounded-xl border p-3 ${
              granted ? 'border-success-500/20 bg-success-500/5' : 'border-border bg-bg-primary'
            }`}
          >
            {granted ? (
              <Check size={16} className="shrink-0 text-success-500" />
            ) : (
              <Lock size={16} className="shrink-0 text-text-secondary/50" />
            )}
            <div>
              <p className={`text-sm font-medium ${granted ? 'text-text-primary' : 'text-text-secondary'}`}>
                {perm.label}
              </p>
              <p className="text-xs text-text-secondary/70">{perm.description}</p>
            </div>
          </div>
        ))}
      </div>
    </motion.div>
  );
}

// ============================================================
// MAIN TEAM PAGE
// ============================================================

export function TeamPage() {
  const navigate = useNavigate();
  const { user, isOwner, profile, profileLoading } = useAuth();
  const { toast } = useToast();

  useKeyboardShortcut({
    key: '/', handler: () => navigate('/dashboard'),
  });

  const [members, setMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInvite, setShowInvite] = useState(false);
  const [editingMember, setEditingMember] = useState<TeamMember | null>(null);

  const loadMembers = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('team_members')
        .select('*')
        .eq('account_owner_id', user.id)
        .order('created_at', { ascending: true });
      if (error) throw error;
      if (data) setMembers(data as TeamMember[]);
    } catch {
      // empty state
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    loadMembers();
  }, [loadMembers]);

  useEffect(() => {
    if (!profileLoading && profile && !profile.onboarding_completed) {
      navigate('/onboarding', { replace: true });
    }
  }, [profile, profileLoading, navigate]);

  const handleRemove = async (member: TeamMember) => {
    try {
      const { error } = await supabase.from('team_members').delete().eq('id', member.id);
      if (error) throw error;
      setMembers((prev) => prev.filter((m) => m.id !== member.id));
      toast(`${member.member_name ?? member.member_email} removed from the team.`, 'success');
    } catch {
      toast('Could not remove team member.', 'error');
    }
  };

  const handleResendInvite = async (member: TeamMember) => {
    try {
      const { error } = await supabase.functions.invoke('send-team-invite', {
        body: {
          memberEmail: member.member_email,
          memberName: member.member_name,
          role: member.role,
        },
      });
      if (error) throw error;
      toast(`Invite resent to ${member.member_email}.`, 'success');
      loadMembers();
    } catch {
      toast('Could not resend the invite. Please try again.', 'error');
    }
  };

  const handleInvited = () => {
    setShowInvite(false);
    loadMembers();
  };

  const handleSaved = () => {
    setEditingMember(null);
    loadMembers();
  };

  return (
    <DashboardLayout activeLabel="Team">
      {/* Page header */}
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent">
            <ShieldCheck size={24} />
          </span>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">Team</h1>
            <p className="mt-1 text-sm text-text-secondary">
              Invite and manage your team members and their permissions.
            </p>
          </div>
        </div>
        {isOwner && (
          <button
            type="button"
            onClick={() => setShowInvite(true)}
            className="focus-ring flex items-center gap-2 rounded-xl bg-cta px-4 py-2.5 text-sm font-semibold text-white transition-all hover:brightness-110"
          >
            <Plus size={16} /> Invite Team Member
          </button>
        )}
      </div>

      {/* My permissions card for non-owners */}
      {!isOwner && (
        <div className="mb-6">
          <MyPermissionsCard />
        </div>
      )}

      {/* Members list */}
      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="flex items-center gap-4 rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark"
            >
              <div className="h-12 w-12 animate-pulse rounded-full bg-bg-tertiary" />
              <div className="flex-1 space-y-2">
                <div className="h-4 w-40 animate-pulse rounded bg-bg-tertiary" />
                <div className="h-3 w-56 animate-pulse rounded bg-bg-tertiary" />
              </div>
            </div>
          ))}
        </div>
      ) : members.length === 0 ? (
        /* Empty state */
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-16 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
            <UserCircle size={26} />
          </span>
          <h3 className="mt-4 text-base font-semibold text-text-primary">It's just you for now</h3>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">
            Invite your team to give them access — technicians can see their assigned jobs, admins
            can manage billing and settings.
          </p>
          {isOwner && (
            <button
              type="button"
              onClick={() => setShowInvite(true)}
              className="focus-ring mt-4 flex items-center gap-2 rounded-xl bg-cta px-4 py-2.5 text-sm font-semibold text-white transition-all hover:brightness-110"
            >
              <Plus size={16} /> Invite your first team member
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {/* Owner row (the account owner themselves) */}
          {profile && (
            <div className="flex items-center gap-4 rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark">
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-accent/15 font-semibold text-accent">
                {(profile.full_name ?? profile.email ?? '?')[0]?.toUpperCase()}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-text-primary">
                  {profile.full_name ?? 'Account Owner'}
                </p>
                <p className="text-xs text-text-secondary">{profile.email}</p>
              </div>
              <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${ROLE_TAGS.owner.color}`}>
                {ROLE_TAGS.owner.label}
              </span>
              <span className="inline-flex rounded-full bg-success-500/10 px-2.5 py-1 text-xs font-medium text-success-500">
                Active
              </span>
            </div>
          )}

          {/* Team members */}
          {members.map((member, i) => (
            <motion.div
              key={member.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, delay: i * 0.04, ease: [0.16, 1, 0.3, 1] }}
              className="flex items-center gap-4 rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark"
            >
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-bg-tertiary font-semibold text-text-secondary">
                {(member.member_name ?? member.member_email ?? '?')[0]?.toUpperCase()}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-text-primary">
                  {member.member_name ?? member.member_email}
                </p>
                <p className="text-xs text-text-secondary">{member.member_email}</p>
              </div>
              <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium capitalize ${ROLE_TAGS[member.role]?.color ?? ROLE_TAGS.member.color}`}>
                {ROLE_TAGS[member.role]?.label ?? member.role}
              </span>
              <span
                className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${
                  member.invite_status === 'active'
                    ? 'bg-success-500/10 text-success-500'
                    : 'bg-warning-500/10 text-warning-500'
                }`}
              >
                {member.invite_status === 'active' ? 'Active' : 'Pending'}
              </span>
              {isOwner && (
                <div className="flex items-center gap-1">
                  {member.invite_status === 'pending' && (
                    <button
                      type="button"
                      onClick={() => handleResendInvite(member)}
                      className="focus-ring flex h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-medium text-text-secondary transition-colors hover:text-text-primary"
                    >
                      <Mail size={14} /> Resend invite
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setEditingMember(member)}
                    className="focus-ring flex h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-medium text-text-secondary transition-colors hover:text-text-primary"
                  >
                    <Settings size={14} /> Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRemove(member)}
                    className="focus-ring flex h-9 w-9 items-center justify-center rounded-lg border border-border text-text-secondary transition-colors hover:border-danger/40 hover:text-danger"
                    aria-label="Remove member"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              )}
            </motion.div>
          ))}
        </div>
      )}

      {/* Invite modal */}
      <AnimatePresence>
        {showInvite && <InviteModal onClose={() => setShowInvite(false)} onInvited={handleInvited} />}
      </AnimatePresence>

      {/* Edit modal */}
      <AnimatePresence>
        {editingMember && (
          <EditModal member={editingMember} onClose={() => setEditingMember(null)} onSaved={handleSaved} />
        )}
      </AnimatePresence>
    </DashboardLayout>
  );
}

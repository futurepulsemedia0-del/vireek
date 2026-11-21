import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Activity, Building2, Download, Eye, EyeOff, Info, KeyRound, Loader2, Lock, LogOut, Mail, Pencil, Settings as SettingsIcon, ShieldCheck, Trash2, User } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { LanguagePreferences } from '@/components/settings/LanguagePreferences';
import { AccountHero } from '@/components/account/AccountHero';
import { AccountSectionNav } from '@/components/account/AccountSectionNav';
import { PasswordStrength } from '@/components/account/PasswordStrength';
import { RecentActivityCard } from '@/components/account/RecentActivityCard';
import { SecuritySnapshot } from '@/components/account/SecuritySnapshot';
import { AccountCard, LinkRow, StatusPill, inputClass, primaryBtn, secondaryBtn } from '@/components/account/ui';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { isValidEmail, isValidPhone } from '@/lib/accountHelpers';
import { supabase } from '@/lib/supabase';

/**
 * My Account — the personal "this is me" page: identity, sign-in, security
 * snapshot, language/region, recent activity and data/privacy shortcuts.
 * Heavy security tooling (MFA enrolment, session revocation, full audit
 * trail, data export, account deletion) deliberately stays on its own
 * pages and is linked from here, so there is one source of truth for each.
 */
export function AccountPage() {
  const navigate = useNavigate();
  const { user, profile, refreshProfile, signOut } = useAuth();
  const { toast } = useToast();
  const { t } = useTranslation('dashboard');

  // ── Profile ────────────────────────────────────────────────────────────
  const [fullName, setFullName] = useState(profile?.full_name ?? '');
  const [phone, setPhone] = useState(profile?.phone ?? '');
  const [savingProfile, setSavingProfile] = useState(false);

  // Keep the form in sync when the profile loads/refreshes (primitive deps, so typing is never clobbered by a same-value refetch).
  useEffect(() => {
    setFullName(profile?.full_name ?? '');
    setPhone(profile?.phone ?? '');
  }, [profile?.id, profile?.full_name, profile?.phone]);

  const profileDirty = fullName.trim() !== (profile?.full_name ?? '') || phone.trim() !== (profile?.phone ?? '');
  const phoneInvalid = !isValidPhone(phone);

  const saveProfile = async (e: FormEvent) => {
    e.preventDefault();
    if (!profile || !profileDirty || phoneInvalid || savingProfile) return;
    setSavingProfile(true);
    const { error } = await supabase
      .from('profiles')
      .update({ full_name: fullName.trim() || null, phone: phone.trim() || null })
      .eq('id', profile.id);
    if (error) {
      toast(t('account.toast.saveFailed'), 'error');
    } else {
      await refreshProfile();
      toast(t('account.toast.saved'), 'success');
    }
    setSavingProfile(false);
  };

  const discardProfile = () => {
    setFullName(profile?.full_name ?? '');
    setPhone(profile?.phone ?? '');
  };

  // ── Email ──────────────────────────────────────────────────────────────
  const [editingEmail, setEditingEmail] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [savingEmail, setSavingEmail] = useState(false);
  const [requestedEmail, setRequestedEmail] = useState<string | null>(null);
  const pendingEmail = requestedEmail ?? (user as { new_email?: string } | null)?.new_email ?? null;
  const emailVerified = Boolean(user?.email_confirmed_at);

  const handleChangeEmail = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = newEmail.trim();
    if (!trimmed || trimmed.toLowerCase() === (user?.email ?? '').toLowerCase()) {
      setEditingEmail(false);
      return;
    }
    if (!isValidEmail(trimmed)) {
      toast(t('account.toast.emailInvalid', { defaultValue: 'Please enter a valid email address.' }), 'error');
      return;
    }
    setSavingEmail(true);
    const { error } = await supabase.auth.updateUser({ email: trimmed });
    setSavingEmail(false);
    if (error) {
      toast(t('account.toast.emailFailed', { message: error.message }), 'error');
      return;
    }
    toast(t('account.toast.emailConfirm'), 'success');
    setRequestedEmail(trimmed);
    setEditingEmail(false);
    setNewEmail('');
  };

  // ── Password ───────────────────────────────────────────────────────────
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [signOutOthers, setSignOutOthers] = useState(true);
  const [savingPassword, setSavingPassword] = useState(false);
  const mismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;

  const handleChangePassword = async (e: FormEvent) => {
    e.preventDefault();
    if (savingPassword) return;
    if (newPassword.length < 8) {
      toast(t('account.toast.passwordShort'), 'error');
      return;
    }
    if (newPassword !== confirmPassword) {
      toast(t('account.toast.passwordMismatch'), 'error');
      return;
    }
    setSavingPassword(true);
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) {
      setSavingPassword(false);
      toast(t('account.toast.passwordFailed', { message: error.message }), 'error');
      return;
    }
    if (signOutOthers) {
      const { error: othersError } = await supabase.auth.signOut({ scope: 'others' });
      if (othersError) {
        toast(t('account.securityCard.signOutFailed', { defaultValue: 'Could not sign out other sessions: {{message}}', message: othersError.message }), 'error');
      }
    }
    setSavingPassword(false);
    toast(t('account.toast.passwordUpdated'), 'success');
    setNewPassword('');
    setConfirmPassword('');
    setShowPassword(false);
  };

  const handleSignOut = async () => {
    await signOut();
    toast(t('nav.signedOut'), 'info');
    navigate('/login', { replace: true });
  };

  return (
    <DashboardLayout activeLabel="My Account">
      <div className="mb-6 flex items-center gap-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent">
          <User size={24} aria-hidden="true" />
        </span>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">{t('nav.items.my_account')}</h1>
          <p className="mt-1 text-sm text-text-secondary">{t('account.subtitle')}</p>
        </div>
      </div>

      <AccountHero />

      <div className="mt-6 lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-8">
        <AccountSectionNav />

        <div className="min-w-0 space-y-4">
          {/* Profile */}
          <AccountCard id="profile" icon={User} title={t('account.profile.title')} description={t('account.profile.subtitle')}>
            <form onSubmit={saveProfile} noValidate>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="text-sm">
                  <span className="mb-1.5 block text-xs font-medium text-text-secondary">{t('account.profile.fullName')}</span>
                  <input
                    type="text"
                    name="name"
                    autoComplete="name"
                    maxLength={120}
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    disabled={savingProfile}
                    placeholder={t('account.profile.fullNamePlaceholder')}
                    className={inputClass}
                  />
                </label>
                <label className="text-sm">
                  <span className="mb-1.5 block text-xs font-medium text-text-secondary">{t('account.profile.phone')}</span>
                  <input
                    type="tel"
                    name="tel"
                    dir="ltr"
                    autoComplete="tel"
                    inputMode="tel"
                    maxLength={32}
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    disabled={savingProfile}
                    aria-invalid={phoneInvalid}
                    aria-describedby={phoneInvalid ? 'account-phone-error' : undefined}
                    placeholder={t('account.profile.phonePlaceholder')}
                    className={`${inputClass} ${phoneInvalid ? 'border-danger/60' : ''}`}
                  />
                  {phoneInvalid && (
                    <span id="account-phone-error" role="alert" className="mt-1.5 block text-xs text-danger">
                      {t('account.profile.phoneInvalid', { defaultValue: 'Enter a valid phone number, e.g. +1 650 910 6703.' })}
                    </span>
                  )}
                </label>
              </div>

              {profile?.company_name && (
                <p className="mt-4 flex items-center gap-2 text-xs text-text-secondary">
                  <Building2 size={14} aria-hidden="true" />
                  <span>
                    {t('account.profile.company', { defaultValue: 'Company' })}: <span className="font-medium text-text-primary">{profile.company_name}</span>
                  </span>
                </p>
              )}

              <div className="mt-5 flex items-center gap-2">
                <button type="submit" disabled={!profileDirty || phoneInvalid || savingProfile} className={primaryBtn}>
                  {savingProfile && <Loader2 size={15} className="animate-spin" aria-hidden="true" />}
                  {savingProfile ? t('account.email.saving') : t('account.email.save')}
                </button>
                {profileDirty && !savingProfile && (
                  <button type="button" onClick={discardProfile} className={secondaryBtn}>
                    {t('account.profile.discard', { defaultValue: 'Discard changes' })}
                  </button>
                )}
              </div>
            </form>
          </AccountCard>

          {/* Email */}
          <AccountCard
            id="email"
            icon={Mail}
            title={t('account.email.title')}
            description={t('account.email.subtitle')}
            action={
              emailVerified ? (
                <StatusPill tone="success">{t('account.hero.verified', { defaultValue: 'Email verified' })}</StatusPill>
              ) : (
                <StatusPill tone="warning">{t('account.email.unverified', { defaultValue: 'Not verified' })}</StatusPill>
              )
            }
          >
            {editingEmail ? (
              <form onSubmit={handleChangeEmail} noValidate className="flex flex-col gap-2 sm:flex-row">
                <input
                  type="email"
                  name="email"
                  dir="ltr"
                  autoComplete="email"
                  maxLength={254}
                  autoFocus
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  placeholder={t('account.email.placeholder')}
                  aria-label={t('account.email.title')}
                  className={`${inputClass} flex-1`}
                />
                <div className="flex gap-2">
                  <button type="submit" disabled={savingEmail || !newEmail.trim()} className={primaryBtn}>
                    {savingEmail && <Loader2 size={15} className="animate-spin" aria-hidden="true" />}
                    {savingEmail ? t('account.email.saving') : t('account.email.save')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEditingEmail(false);
                      setNewEmail('');
                    }}
                    className={secondaryBtn}
                  >
                    {t('account.email.cancel')}
                  </button>
                </div>
              </form>
            ) : (
              <div className="flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-bg-primary px-4 py-3">
                <span dir="ltr" className="truncate text-sm text-text-primary">
                  {user?.email}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setNewEmail(user?.email ?? '');
                    setEditingEmail(true);
                  }}
                  className="focus-ring flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-accent hover:bg-accent/10"
                >
                  <Pencil size={13} aria-hidden="true" />
                  {t('account.email.change')}
                </button>
              </div>
            )}
            {pendingEmail && (
              <p role="status" className="mt-3 flex items-start gap-2 rounded-xl bg-warning-subtle px-3.5 py-2.5 text-xs text-text-primary">
                <Info size={14} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
                <span>
                  {t('account.email.pending', { defaultValue: 'A change to {{email}} is waiting for confirmation. Check both inboxes.', email: pendingEmail })}
                </span>
              </p>
            )}
            <p className="mt-3 text-xs text-text-secondary">{t('account.email.note')}</p>
          </AccountCard>

          {/* Password */}
          <AccountCard id="password" icon={KeyRound} title={t('account.password.title')} description={t('account.password.subtitle')}>
            <form onSubmit={handleChangePassword} noValidate>
              <input type="text" name="username" autoComplete="username" value={user?.email ?? ''} readOnly tabIndex={-1} aria-hidden="true" className="sr-only" />
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder={t('account.password.new')}
                    aria-label={t('account.password.new')}
                    autoComplete="new-password"
                    className={`${inputClass} pe-11`}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? t('account.password.hide', { defaultValue: 'Hide passwords' }) : t('account.password.show', { defaultValue: 'Show passwords' })}
                    aria-pressed={showPassword}
                    className="focus-ring absolute end-1.5 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
                  >
                    {showPassword ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
                  </button>
                </div>
                <div>
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder={t('account.password.confirm')}
                    aria-label={t('account.password.confirm')}
                    aria-invalid={mismatch}
                    autoComplete="new-password"
                    className={`${inputClass} ${mismatch ? 'border-danger/60' : ''}`}
                  />
                  {mismatch && (
                    <p role="alert" className="mt-1.5 text-xs text-danger">
                      {t('account.toast.passwordMismatch')}
                    </p>
                  )}
                </div>
              </div>

              <PasswordStrength password={newPassword} email={user?.email} />

              <label className="mt-4 flex cursor-pointer items-start gap-2.5 text-sm text-text-primary">
                <input
                  type="checkbox"
                  checked={signOutOthers}
                  onChange={(e) => setSignOutOthers(e.target.checked)}
                  className="focus-ring mt-0.5 h-4 w-4 rounded border-border accent-[rgb(var(--accent))]"
                />
                <span>
                  {t('account.password.signOutOthers', { defaultValue: 'Sign out of all other devices after changing my password' })}
                  <span className="block text-xs text-text-secondary">
                    {t('account.password.signOutOthersHint', { defaultValue: 'Recommended — anyone using your old password is signed out immediately.' })}
                  </span>
                </span>
              </label>

              <button type="submit" disabled={savingPassword || !newPassword || !confirmPassword} className={`${primaryBtn} mt-5`}>
                {savingPassword && <Loader2 size={15} className="animate-spin" aria-hidden="true" />}
                {savingPassword ? t('account.password.updating') : t('account.password.update')}
              </button>
            </form>
          </AccountCard>

          {/* Security snapshot */}
          <AccountCard
            id="security"
            icon={ShieldCheck}
            title={t('account.security.title')}
            description={t('account.security.description')}
          >
            <SecuritySnapshot />
          </AccountCard>

          {/* Language & region */}
          <div id="preferences" className="scroll-mt-24">
            <LanguagePreferences />
          </div>

          {/* Recent activity */}
          <AccountCard
            id="activity"
            icon={Activity}
            title={t('account.activity.title', { defaultValue: 'Recent activity' })}
            description={t('account.activity.subtitle', { defaultValue: 'Sign-ins and security changes on your account.' })}
          >
            <RecentActivityCard />
          </AccountCard>

          {/* Data & privacy */}
          <AccountCard
            id="data"
            icon={Lock}
            title={t('account.data.title', { defaultValue: 'Data & privacy' })}
            description={t('account.data.subtitle', { defaultValue: 'Your data, your workspace and your exit options.' })}
          >
            <div className="space-y-2">
              <LinkRow to="/dashboard/business-profile" icon={Building2} title={t('account.data.business', { defaultValue: 'Business profile' })} description={t('account.data.businessHint', { defaultValue: 'Company details, branding and service info.' })} />
              <LinkRow to="/dashboard/settings" icon={SettingsIcon} title={t('account.workspace.title')} description={t('account.workspace.description')} />
              <LinkRow to="/dashboard/settings/security" icon={Download} title={t('account.data.export', { defaultValue: 'Export your data' })} description={t('account.data.exportHint', { defaultValue: 'Download a copy of everything stored for your account.' })} />
              <LinkRow to="/dashboard/settings/security" icon={Trash2} title={t('account.data.delete', { defaultValue: 'Delete account' })} description={t('account.data.deleteHint', { defaultValue: 'Permanently remove your account and data.' })} />
            </div>
            <div className="mt-5 border-t border-border/70 pt-4">
              <button type="button" onClick={handleSignOut} className={secondaryBtn}>
                <LogOut size={15} aria-hidden="true" />
                {t('account.data.signOut', { defaultValue: 'Sign out' })}
              </button>
            </div>
          </AccountCard>
        </div>
      </div>
    </DashboardLayout>
  );
}

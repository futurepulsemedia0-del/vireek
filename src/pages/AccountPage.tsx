import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { User, Mail, KeyRound, ShieldCheck, Settings as SettingsIcon, ChevronRight, Pencil } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { LanguagePreferences } from '@/components/settings/LanguagePreferences';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { supabase } from '@/lib/supabase';

function initialsFor(name: string | null, email: string | null): string {
  if (name && name.trim()) {
    const parts = name.trim().split(/\s+/);
    return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || name[0].toUpperCase();
  }
  if (email) return email[0].toUpperCase();
  return '?';
}

/**
 * Account — the personal, "this is me" counterpart to Settings (which is
 * workspace/notification preferences) and Business Profile (which is the
 * company record). Deliberately does NOT re-implement 2FA / active
 * sessions / the audit log / data export / account deletion: all of that
 * already lives on SecuritySettingsPage against real, working Supabase
 * plumbing (MFA API, list_own_sessions/revoke_own_session RPCs, the
 * delete-account edge function). Duplicating it here would just be two
 * copies of the same state to keep in sync and drift apart. Instead this
 * page owns identity fields that don't belong anywhere else yet (name,
 * phone, email, password) and links out to Security and Settings for
 * everything else — same pattern SettingsPage already uses for Security/
 * API keys/Assistant persona.
 */
export function AccountPage() {
  const navigate = useNavigate();
  const { user, profile, refreshProfile } = useAuth();
  const { toast } = useToast();
  const { t } = useTranslation('dashboard');

  const [fullName, setFullName] = useState(profile?.full_name ?? '');
  const [phone, setPhone] = useState(profile?.phone ?? '');
  const [savingField, setSavingField] = useState<'full_name' | 'phone' | null>(null);

  const [editingEmail, setEditingEmail] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [savingEmail, setSavingEmail] = useState(false);

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);

  const saveProfileField = async (field: 'full_name' | 'phone', value: string) => {
    if (!profile) return;
    const trimmed = value.trim();
    const current = field === 'full_name' ? profile.full_name : profile.phone;
    if (trimmed === (current ?? '')) return;

    setSavingField(field);
    const { error } = await supabase
      .from('profiles')
      .update({ [field]: trimmed || null })
      .eq('id', profile.id);

    if (error) {
      toast(t('account.toast.saveFailed'), 'error');
    } else {
      await refreshProfile();
      toast(t('account.toast.saved'), 'success');
    }
    setSavingField(null);
  };

  const handleChangeEmail = async () => {
    const trimmed = newEmail.trim();
    if (!trimmed || trimmed === user?.email) {
      setEditingEmail(false);
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
    setEditingEmail(false);
    setNewEmail('');
  };

  const handleChangePassword = async () => {
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
    setSavingPassword(false);
    if (error) {
      toast(t('account.toast.passwordFailed', { message: error.message }), 'error');
      return;
    }
    toast(t('account.toast.passwordUpdated'), 'success');
    setNewPassword('');
    setConfirmPassword('');
  };

  return (
    <DashboardLayout activeLabel="My Account">
      <div className="mb-6 flex items-center gap-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent">
          <User size={24} />
        </span>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">
            {t('nav.items.my_account')}
          </h1>
          <p className="mt-1 text-sm text-text-secondary">{t('account.subtitle')}</p>
        </div>
      </div>

      {/* Profile info */}
      <div className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
        <div className="flex items-center gap-4">
          <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-accent/10 text-lg font-semibold text-accent">
            {initialsFor(profile?.full_name ?? null, user?.email ?? null)}
          </span>
          <div>
            <h2 className="text-base font-semibold text-text-primary">{t('account.profile.title')}</h2>
            <p className="text-xs text-text-secondary">{t('account.profile.subtitle')}</p>
          </div>
        </div>

        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <label className="text-sm">
            <span className="mb-1.5 block text-xs font-medium text-text-secondary">
              {t('account.profile.fullName')}
            </span>
            <input
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              onBlur={(e) => saveProfileField('full_name', e.target.value)}
              disabled={savingField === 'full_name'}
              placeholder={t('account.profile.fullNamePlaceholder')}
              className="w-full rounded-xl border border-border bg-bg-primary px-3.5 py-2.5 text-sm text-text-primary focus-ring disabled:opacity-60"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1.5 block text-xs font-medium text-text-secondary">
              {t('account.profile.phone')}
            </span>
            <input
              type="tel"
              dir="ltr"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              onBlur={(e) => saveProfileField('phone', e.target.value)}
              disabled={savingField === 'phone'}
              placeholder={t('account.profile.phonePlaceholder')}
              className="w-full rounded-xl border border-border bg-bg-primary px-3.5 py-2.5 text-sm text-text-primary focus-ring disabled:opacity-60"
            />
          </label>
        </div>
      </div>

      {/* Language & region */}
      <LanguagePreferences className="mt-4" />

      {/* Email */}
      <div className="mt-4 rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-bg-tertiary text-text-secondary">
            <Mail size={18} />
          </span>
          <div>
            <h2 className="text-base font-semibold text-text-primary">{t('account.email.title')}</h2>
            <p className="text-xs text-text-secondary">{t('account.email.subtitle')}</p>
          </div>
        </div>

        <div className="mt-4">
          {editingEmail ? (
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                type="email"
                dir="ltr"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                placeholder={t('account.email.placeholder')}
                className="w-full flex-1 rounded-xl border border-border bg-bg-primary px-3.5 py-2.5 text-sm text-text-primary focus-ring"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleChangeEmail}
                  disabled={savingEmail || !newEmail.trim()}
                  className="focus-ring rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
                >
                  {savingEmail ? t('account.email.saving') : t('account.email.save')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditingEmail(false);
                    setNewEmail('');
                  }}
                  className="focus-ring rounded-xl border border-border px-4 py-2.5 text-sm font-medium text-text-primary"
                >
                  {t('account.email.cancel')}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between rounded-xl border border-border/60 bg-bg-primary px-4 py-3">
              <span dir="ltr" className="text-sm text-text-primary">
                {user?.email}
              </span>
              <button
                type="button"
                onClick={() => {
                  setNewEmail(user?.email ?? '');
                  setEditingEmail(true);
                }}
                className="focus-ring flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-accent hover:bg-accent/10"
              >
                <Pencil size={13} />
                {t('account.email.change')}
              </button>
            </div>
          )}
          <p className="mt-2 text-xs text-text-secondary">{t('account.email.note')}</p>
        </div>
      </div>

      {/* Password */}
      <div className="mt-4 rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-bg-tertiary text-text-secondary">
            <KeyRound size={18} />
          </span>
          <div>
            <h2 className="text-base font-semibold text-text-primary">{t('account.password.title')}</h2>
            <p className="text-xs text-text-secondary">{t('account.password.subtitle')}</p>
          </div>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder={t('account.password.new')}
            autoComplete="new-password"
            className="w-full rounded-xl border border-border bg-bg-primary px-3.5 py-2.5 text-sm text-text-primary focus-ring"
          />
          <input
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder={t('account.password.confirm')}
            autoComplete="new-password"
            className="w-full rounded-xl border border-border bg-bg-primary px-3.5 py-2.5 text-sm text-text-primary focus-ring"
          />
        </div>
        <button
          type="button"
          onClick={handleChangePassword}
          disabled={savingPassword || !newPassword || !confirmPassword}
          className="focus-ring mt-4 rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {savingPassword ? t('account.password.updating') : t('account.password.update')}
        </button>
      </div>

      {/* Link out: Security & sessions (already fully built on its own page) */}
      <button
        type="button"
        onClick={() => navigate('/dashboard/settings/security')}
        className="focus-ring mt-4 flex w-full items-center justify-between rounded-2xl border border-border bg-bg-secondary p-6 text-start shadow-card transition-all hover:-translate-y-0.5 hover:border-accent/25 hover:shadow-card-hover dark:shadow-card-dark dark:hover:shadow-card-hover-dark"
      >
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <ShieldCheck size={20} />
          </span>
          <div>
            <p className="text-sm font-semibold text-text-primary">{t('account.security.title')}</p>
            <p className="mt-0.5 text-xs text-text-secondary">{t('account.security.description')}</p>
          </div>
        </div>
        <ChevronRight size={18} className="text-text-secondary" />
      </button>

      {/* Link out: workspace settings */}
      <button
        type="button"
        onClick={() => navigate('/dashboard/settings')}
        className="focus-ring mt-4 flex w-full items-center justify-between rounded-2xl border border-border bg-bg-secondary p-6 text-start shadow-card transition-all hover:-translate-y-0.5 hover:border-accent/25 hover:shadow-card-hover dark:shadow-card-dark dark:hover:shadow-card-hover-dark"
      >
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <SettingsIcon size={20} />
          </span>
          <div>
            <p className="text-sm font-semibold text-text-primary">{t('account.workspace.title')}</p>
            <p className="mt-0.5 text-xs text-text-secondary">{t('account.workspace.description')}</p>
          </div>
        </div>
        <ChevronRight size={18} className="text-text-secondary" />
      </button>
    </DashboardLayout>
  );
}

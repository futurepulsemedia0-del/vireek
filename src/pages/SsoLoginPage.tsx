import { useState } from 'react';
import { Building2, Loader2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { AuthShell, AuthSidePanel } from '@/components/auth/AuthParts';
import { signInWithSsoDomain } from '@/lib/enterpriseSecurity';

export function SsoLoginPage() {
  const [domain, setDomain] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!domain.trim()) return;
    setLoading(true);
    setError('');
    try {
      const url = await signInWithSsoDomain(domain.trim().toLowerCase());
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "We couldn't find an SSO connection for that domain.");
      setLoading(false);
    }
  };

  return (
    <AuthShell side={<AuthSidePanel />}>
      <div className="mb-6 flex items-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent">
          <Building2 size={20} />
        </span>
        <h1 className="text-xl font-bold text-text-primary">Sign in with company SSO</h1>
      </div>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="mb-1 block text-sm text-text-secondary">Company domain</label>
          <input
            type="text"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="yourcompany.com"
            className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary"
          />
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
        <button
          type="submit"
          disabled={loading}
          className="focus-ring flex w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white transition-all hover:brightness-110 disabled:opacity-50"
        >
          {loading && <Loader2 size={14} className="animate-spin" />}
          Continue
        </button>
      </form>
      <p className="mt-6 text-center text-sm text-text-secondary">
        <Link to="/login" className="font-medium text-accent hover:underline">Back to regular sign in</Link>
      </p>
    </AuthShell>
  );
}

// Recreated: verify against original intent
// /dashboard/voice-platform
//
// TODO(vireek): the original page is not in the repository and no spec for it exists, so this page only does
// what can be done truthfully with what exists: it shows the industry pack saved for this account and the packs
// that are available. Changing pack, compliance acknowledgements and per-pack settings need the backend described
// in src/lib/voicePlatform.ts and are intentionally not offered.

import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Briefcase } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/lib/supabase';
import { getPack, listPacks, normalizeVerticalId } from '@/lib/voicePlatform';

export function VoicePlatformPage() {
  const { user, isOwner, teamMember } = useAuth();
  const ownerId: string | null = isOwner ? user?.id ?? null : teamMember?.account_owner_id ?? null;
  const [verticalId, setVerticalId] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const seq = useRef(0);

  const load = async () => {
    if (!ownerId) return;
    const mine = ++seq.current;
    setError(false);
    try {
      const { data, error: err } = await supabase.from('business_profile').select('vertical_id').eq('user_id', ownerId).maybeSingle();
      if (err) throw err;
      if (mine === seq.current) setVerticalId(normalizeVerticalId((data as { vertical_id?: string | null } | null)?.vertical_id));
    } catch {
      if (mine === seq.current) setError(true);
    }
  };

  useEffect(() => {
    void load();
    return () => { seq.current++; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerId]);

  const current = getPack(verticalId);

  return (
    <DashboardLayout activeLabel="Voice Platform">
      <div className="mb-6">
        <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary"><Briefcase size={22} aria-hidden="true" /> Voice platform</h1>
        <p className="mt-1 text-sm text-text-secondary">The industry your assistant is set up for.</p>
      </div>

      {error && (
        <p role="alert" className="mb-4 rounded-xl border border-danger/30 bg-danger/5 p-3 text-sm text-danger">
          Could not load your industry setting. <button type="button" onClick={() => void load()} className="focus-ring font-semibold underline">Try again</button>
        </p>
      )}
      {!verticalId && !error && <p role="status" className="py-6 text-sm text-text-secondary">Loading…</p>}

      {current && (
        <section aria-labelledby="vp-current" className="rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5">
          <h2 id="vp-current" className="text-base font-semibold text-text-primary">Current industry</h2>
          <p className="mt-2 text-sm font-medium text-text-primary">{current.label}</p>
          <p className="mt-1 text-sm text-text-secondary">{current.description}</p>
          <p className="mt-3 text-xs text-text-secondary">You can pick your industry during setup. <Link to="/dashboard/settings/center" className="focus-ring font-semibold text-accent underline">Open the Settings Center</Link> for everything else.</p>
        </section>
      )}

      <section aria-labelledby="vp-available" className="mt-4 rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5">
        <h2 id="vp-available" className="text-base font-semibold text-text-primary">Available industry packs</h2>
        <ul className="mt-3 divide-y divide-border rounded-xl border border-border text-sm">
          {listPacks().map((p) => (
            <li key={p.id} className="px-3 py-2">
              <p className="font-medium text-text-primary">{p.label}{p.id === verticalId && <span className="ms-2 text-xs font-semibold text-success-500">In use</span>}</p>
              <p className="text-xs text-text-secondary">{p.description}</p>
            </li>
          ))}
        </ul>
      </section>
    </DashboardLayout>
  );
}

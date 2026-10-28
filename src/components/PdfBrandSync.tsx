import { useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { BRAND_CHANGED_EVENT, loadPdfBrand, setPdfBrand } from '@/lib/pdfBrand';

/** Keeps the ambient PDF brand in sync with the signed-in ACCOUNT (owner, not the member). */
export function PdfBrandSync() {
  const { profile, isOwner, teamMember } = useAuth();
  const ownerId = isOwner ? profile?.id : teamMember?.account_owner_id;
  const name = profile?.company_name ?? null;

  useEffect(() => {
    if (!ownerId) {
      setPdfBrand(null);
      return;
    }
    let cancelled = false;
    const run = async () => {
      const brand = await loadPdfBrand(ownerId, name);
      if (!cancelled) setPdfBrand(brand);
    };
    void run();
    const onChange = () => void run();
    window.addEventListener(BRAND_CHANGED_EVENT, onChange);
    return () => {
      cancelled = true;
      window.removeEventListener(BRAND_CHANGED_EVENT, onChange);
    };
  }, [ownerId, name]);

  return null;
}

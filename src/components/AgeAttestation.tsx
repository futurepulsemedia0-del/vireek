import { Link } from 'react-router-dom';
import { MIN_AGE_YEARS, MINOR_DELETION_PATH } from '@/lib/minorsPolicy';

/**
 * Required checkbox for consumer-facing forms. It is an attestation, not age verification: Vireek is a business tool
 * and does not collect dates of birth. Wording is a placeholder.
 * TODO(counsel): approve the wording (and any parental-consent alternative) before relying on it.
 */
export function AgeAttestation({ id, checked, onChange }: { id: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div>
      <label htmlFor={id} className="flex min-h-[44px] items-start gap-3 text-xs text-text-secondary">
        <input id={id} type="checkbox" required checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 h-5 w-5 shrink-0" />
        <span>I am at least {MIN_AGE_YEARS} years old. This service is for businesses and their customers, not for children.</span>
      </label>
      <p className="ms-8 text-[11px] text-text-secondary">
        If a child&apos;s information was sent by mistake, <Link to={MINOR_DELETION_PATH} className="focus-ring font-semibold underline">ask us to delete it</Link>.
      </p>
    </div>
  );
}

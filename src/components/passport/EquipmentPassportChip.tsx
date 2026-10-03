import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { QrCode } from 'lucide-react';
import { formatPassportCode, passportCodeForEquipment } from '@/lib/equipmentPassport';

/** Small "Passport VEQ-…" link shown on each equipment card of a customer. Renders nothing until a verified passport exists. */
export function EquipmentPassportChip({ equipmentId }: { equipmentId: string }) {
  const [code, setCode] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    passportCodeForEquipment(equipmentId)
      .then((c) => { if (!cancelled) setCode(c); })
      .catch(() => { if (!cancelled) setCode(null); });
    return () => { cancelled = true; };
  }, [equipmentId]);

  if (!code) return null;
  return (
    <Link
      to={`/dashboard/equipment-passports/${code}`}
      className="focus-ring mt-3 inline-flex items-center gap-1.5 rounded-lg bg-accent/10 px-2.5 py-1.5 text-[11px] font-semibold text-accent hover:bg-accent/15"
    >
      <QrCode size={12} aria-hidden="true" /> Passport {formatPassportCode(code)}
    </Link>
  );
}

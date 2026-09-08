import { useSearchParams } from 'react-router-dom';
import { Phone } from 'lucide-react';

// Public, unauthenticated, zero-backend page meant to be embedded via
// <iframe> on a customer's own website. It never touches Supabase — the
// only input is the optional `business` query param used purely for
// personalizing the label. This keeps it safe to embed anywhere with no
// auth, no RLS surface, and no data to leak.
export function BadgePage() {
  const [params] = useSearchParams();
  const businessName = params.get('business');

  return (
    <a
      href="https://vireek.com?utm_source=badge&utm_medium=embed"
      target="_blank"
      rel="noopener noreferrer"
      className="flex h-full w-full items-center justify-center bg-transparent p-1 no-underline"
      style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}
    >
      <span className="flex items-center gap-2.5 rounded-full border border-[#e5e7eb] bg-white px-4 py-2 shadow-sm transition-transform hover:scale-[1.02]">
        <span className="relative flex h-2.5 w-2.5 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#22c55e] opacity-60" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-[#22c55e]" />
        </span>
        <Phone size={14} className="shrink-0 text-[#111827]" />
        <span className="text-[13px] font-semibold leading-none text-[#111827]">
          {businessName ? `${businessName} — Always Answered` : 'Always Answered'}
        </span>
        <span className="text-[11px] leading-none text-[#9ca3af]">by Vireek AI</span>
      </span>
    </a>
  );
}

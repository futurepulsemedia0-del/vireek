import { MessageCircle, Send, X } from 'lucide-react';
import { readableTextColor, type ChatWidgetSettings } from '@/lib/chatWidget';

export type PreviewState = 'online' | 'offline';
export type PreviewTheme = 'light' | 'dark';

interface Props {
  settings: ChatWidgetSettings;
  state: PreviewState;
  theme: PreviewTheme;
  businessName?: string | null;
}

const PALETTE = {
  light: { panel: '#FFFFFF', surface: '#F3F4F6', text: '#111827', muted: '#6B7280', border: '#E5E7EB' },
  dark: { panel: '#111827', surface: '#1F2937', text: '#F9FAFB', muted: '#9CA3AF', border: '#374151' },
} as const;

/**
 * Pixel-faithful miniature of the embedded widget. Colors are inline on purpose: the preview must show what the
 * customer's visitors see, not the Vireek dashboard theme.
 */
export function ChatWidgetPreview({ settings, state, theme, businessName }: Props) {
  const c = PALETTE[theme];
  const brand = /^#[0-9a-fA-F]{6}$/.test(settings.brand_color) ? settings.brand_color : '#3448E8';
  const onBrand = readableTextColor(brand);
  const online = state === 'online';
  const hidden = !online && settings.offline_behavior === 'hide';
  const canSend = online || settings.offline_behavior === 'collect_lead';
  const needsContact = !online && settings.contact_field !== 'none' && canSend;
  const side = settings.position === 'left' ? 'left-3' : 'right-3';
  const align = settings.position === 'left' ? 'items-start' : 'items-end';

  return (
    <div
      className="relative h-[460px] w-full overflow-hidden rounded-2xl border border-border/80 bg-gradient-to-br from-bg-tertiary to-bg-secondary"
      role="img"
      aria-label="Live preview of your chat widget"
    >
      <div className="space-y-2 p-4" aria-hidden>
        <div className="h-3 w-1/3 rounded bg-border/80" />
        <div className="h-2.5 w-2/3 rounded bg-border/60" />
        <div className="h-2.5 w-1/2 rounded bg-border/60" />
        <div className="mt-4 h-20 w-full rounded-lg bg-border/40" />
      </div>

      {hidden ? (
        <p className="absolute inset-x-4 bottom-4 rounded-xl border border-dashed border-border bg-bg-secondary/90 px-3 py-2 text-center text-xs text-text-secondary">
          Outside business hours the widget is hidden from your website.
        </p>
      ) : (
        <div className={`absolute bottom-3 ${side} flex w-[min(300px,calc(100%-24px))] flex-col gap-2 ${align}`}>
          <div className="w-full overflow-hidden rounded-2xl shadow-xl" style={{ background: c.panel, border: `1px solid ${c.border}` }}>
            <div className="flex items-center justify-between gap-2 px-4 py-3" style={{ background: brand, color: onBrand }}>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{settings.title || 'Chat with us'}</p>
                <p className="flex items-center gap-1.5 text-[11px] opacity-90">
                  <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: online ? '#22C55E' : '#9CA3AF' }} />
                  {online ? businessName || 'We typically reply in minutes' : 'Offline'}
                </p>
              </div>
              <X size={14} aria-hidden />
            </div>

            <div className="space-y-2 px-3 py-3" style={{ minHeight: 120 }}>
              <div className="max-w-[85%] rounded-2xl rounded-bl-sm px-3 py-2 text-xs leading-relaxed" style={{ background: c.surface, color: c.text }}>
                {online ? settings.greeting || 'Hi! How can we help you today?' : settings.offline_message}
              </div>
            </div>

            {needsContact && (
              <div className="space-y-1.5 px-3 pb-2">
                {(settings.contact_field === 'email' || settings.contact_field === 'either') && (
                  <div className="rounded-lg px-2.5 py-1.5 text-[11px]" style={{ border: `1px solid ${c.border}`, color: c.muted }}>
                    you@company.com
                  </div>
                )}
                {(settings.contact_field === 'phone' || settings.contact_field === 'either') && (
                  <div className="rounded-lg px-2.5 py-1.5 text-[11px]" style={{ border: `1px solid ${c.border}`, color: c.muted }}>
                    Phone number
                  </div>
                )}
              </div>
            )}

            <div className="flex items-center gap-2 p-2.5" style={{ borderTop: `1px solid ${c.border}`, opacity: canSend ? 1 : 0.55 }}>
              <div className="flex-1 rounded-lg px-2.5 py-1.5 text-[11px]" style={{ border: `1px solid ${c.border}`, color: c.muted }}>
                {canSend ? (online ? 'Type a message…' : 'Leave a message…') : 'Messaging unavailable'}
              </div>
              <span className="flex h-7 w-7 items-center justify-center rounded-lg" style={{ background: brand, color: onBrand }}>
                <Send size={13} aria-hidden />
              </span>
            </div>
          </div>

          <span className="flex h-12 w-12 items-center justify-center rounded-full shadow-lg" style={{ background: brand, color: onBrand }}>
            <MessageCircle size={22} aria-hidden />
          </span>
        </div>
      )}
    </div>
  );
}

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { brandCssVars, fetchPortalBranding, logoPublicUrl, type PortalBranding } from '@/lib/branding';
import { portalDocumentTitle, tailwindBrandVars } from '@/lib/whiteLabel';

type State = { ready: false } | { ready: true; branding: PortalBranding | null };

/**
 * Replaces the marketing Header/Footer on every customer-portal page.
 * - No Vireek string is rendered unless the server says the badge is required
 *   (get_portal_branding returns the EFFECTIVE flag, already plan-aware).
 * - Nothing brand-related renders while loading, so a white-labeled portal never flashes Vireek.
 */
export function PortalBrandShell({
  token,
  welcome = false,
  children,
}: {
  token: string | undefined;
  welcome?: boolean;
  children: ReactNode;
}) {
  const [state, setState] = useState<State>({ ready: false });

  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setState({ ready: true, branding: null });
      return;
    }
    setState({ ready: false });
    fetchPortalBranding(token)
      .then((branding) => {
        if (!cancelled) setState({ ready: true, branding });
      })
      .catch(() => {
        if (!cancelled) setState({ ready: true, branding: null });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const branding = state.ready ? state.branding : null;
  const name = branding?.business_name?.trim() || '';
  const logoUrl = branding ? logoPublicUrl(branding.logo_path) : null;

  // Tab title + favicon
  useEffect(() => {
    if (!branding) return;
    const prevTitle = document.title;
    document.title = portalDocumentTitle(name);
    const link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
    const prevHref = link?.getAttribute('href') ?? null;
    const prevType = link?.getAttribute('type') ?? null;
    if (link && logoUrl) {
      link.setAttribute('href', logoUrl);
      link.removeAttribute('type');
    }
    return () => {
      document.title = prevTitle;
      if (link && logoUrl) {
        if (prevHref !== null) link.setAttribute('href', prevHref);
        if (prevType !== null) link.setAttribute('type', prevType);
      }
    };
  }, [branding, name, logoUrl]);

  // Honor the portal theme chosen in Branding (the app themes via a class on <html>).
  const theme = branding?.portal_theme;
  useEffect(() => {
    if (theme !== 'dark' && theme !== 'light') return;
    const root = document.documentElement;
    const had = root.classList.contains('dark');
    root.classList.toggle('dark', theme === 'dark');
    return () => {
      root.classList.toggle('dark', had);
    };
  }, [theme]);

  const style = branding
    ? ({
        ...tailwindBrandVars(branding.primary_color, branding.accent_color),
        ...brandCssVars(branding.primary_color, branding.accent_color),
      } as CSSProperties)
    : undefined;

  const showWelcome = welcome && branding && (branding.portal_welcome_title || branding.portal_welcome_message);

  return (
    <div className="flex min-h-screen flex-col bg-bg-primary" style={style}>
      {branding && (
        <header style={{ background: 'var(--brand-primary)', color: 'var(--brand-on-primary)' }}>
          <div className="mx-auto flex w-full max-w-3xl items-center gap-3 px-4 py-3">
            {logoUrl ? (
              <>
                <img src={logoUrl} alt={name} className="h-9 max-w-[160px] rounded object-contain" />
              </>
            ) : (
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/20 text-sm font-bold" aria-hidden="true">
                {(name || '?').slice(0, 1).toUpperCase()}
              </span>
            )}
            {!logoUrl && <span className="truncate text-base font-semibold">{name}</span>}
          </div>
        </header>
      )}

      {showWelcome && (
        <section className="border-b border-border bg-bg-secondary px-4 py-5">
          <div className="mx-auto w-full max-w-3xl">
            {branding?.portal_welcome_title && (
              <h2 className="text-lg font-semibold text-text-primary">{branding.portal_welcome_title}</h2>
            )}
            {branding?.portal_welcome_message && (
              <p className="mt-1 text-sm leading-relaxed text-text-secondary">{branding.portal_welcome_message}</p>
            )}
          </div>
        </section>
      )}

      {children}

      {branding && (
        <footer className="border-t border-border px-4 py-6 text-center text-xs text-text-secondary">
          {name && <p>© {new Date().getFullYear()} {name}</p>}
          {branding.portal_show_powered_by && (
            <p className="mt-1">
              Powered by{' '}
              <a href="https://vireek.com" target="_blank" rel="noopener noreferrer" className="underline">
                Vireek
              </a>
            </p>
          )}
        </footer>
      )}
    </div>
  );
}

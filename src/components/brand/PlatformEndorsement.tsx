import { useEffect } from 'react';
import { getEndorsement, getParentOrganizationJsonLd } from '@/lib/brand/platformEndorsement';

const LD_ID = 'vireek-parent-org-ld';

/**
 * Renders "Part of {parent}" for PLATFORM-owned surfaces only. Renders nothing (no DOM node)
 * when the platform flag is OFF or no valid parent name is configured.
 * Never mount this inside tenant-branded or customer-facing documents.
 */
export function PlatformEndorsement({ className }: { className?: string }) {
  const { line, parentName, parentUrl } = getEndorsement();
  if (!line || !parentName) return null;
  const prefix = line.slice(0, line.length - parentName.length);
  return (
    <p className={className} data-testid="platform-endorsement">
      {prefix}
      {parentUrl ? (
        <a href={parentUrl} rel="noopener noreferrer" className="font-medium underline-offset-2 hover:underline focus-ring rounded">
          {parentName}
        </a>
      ) : (
        parentName
      )}
    </p>
  );
}

/** Injects Organization JSON-LD with parentOrganization — only when the endorsement is enabled. */
export function EndorsementStructuredData() {
  useEffect(() => {
    const data = getParentOrganizationJsonLd();
    if (!data) return;
    const script = document.createElement('script');
    script.type = 'application/ld+json';
    script.id = LD_ID;
    script.textContent = JSON.stringify(data).replace(/</g, '\\u003c');
    document.head.appendChild(script);
    return () => script.remove();
  }, []);
  return null;
}

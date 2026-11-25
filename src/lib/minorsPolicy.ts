// src/lib/minorsPolicy.ts
// Single source for the "not directed to children" rule on consumer-facing forms (public booking, customer portal).
// Docs: docs/privacy/minors.md.

/**
 * Minimum age for submitting a consumer-facing form. 16 is the figure already published in the Privacy Policy
 * ("not directed toward children under 16", PrivacyContent.tsx section 10), kept here so the two cannot drift silently.
 * TODO(counsel): confirm the threshold per launch region (it can differ by jurisdiction) and update both places together.
 */
export const MIN_AGE_YEARS = 16;

/** Where a person goes to ask for their (or a child's) information to be deleted. Existing page: DataRequestPage. */
export const MINOR_DELETION_PATH = '/data-request';

/** Forms that show the attestation. Add a form here when it starts collecting personal data from the public. */
export const AGE_GATED_FORMS = ['public_booking', 'portal_service_request'] as const;
export type AgeGatedForm = (typeof AGE_GATED_FORMS)[number];

/** A form may submit only once the person has ticked the attestation. */
export const ageGatePassed = (attested: boolean): boolean => attested === true;

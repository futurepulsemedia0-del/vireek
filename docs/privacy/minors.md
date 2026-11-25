# Children's data (minors)

Status: DRAFT template. Not legal advice. Every `TODO(counsel)` needs a lawyer's answer; every `TODO(owner)` needs a fact only you have.

## 1. Position

- Vireek is a B2B product for service businesses. It is not directed to children and does not knowingly collect children's personal data.
- Published statement today: Privacy Policy section 10 ("Children's Privacy", `src/components/sections/PrivacyContent.tsx`) says "not directed toward children under 16".
- TODO(counsel): confirm 16 is right for each region you sell in (thresholds differ by jurisdiction) and whether a parental-consent route is needed anywhere. The code constant `MIN_AGE_YEARS` (`src/lib/minorsPolicy.ts`) and the policy text must change together; a test fails if they drift.
- TODO(counsel): the Terms of Service (`TermsContent.tsx`) have no eligibility/age clause today. Decide whether to add one and supply the wording. Not drafted here.

## 2. Where consumers enter data

| Form | File | Control |
|---|---|---|
| Public booking page | `src/pages/BookingPage.tsx` | Required age attestation (`AgeAttestation`); submit disabled until ticked |
| Customer portal "Request Service" | `src/pages/CustomerPortalPage.tsx` | Same attestation; submit blocked and an error shown if unticked |

Other public pages that collect personal data (for example the data-request form, change-order and lien-waiver pages) were not given an attestation: they are used by identified adults acting on a specific business matter. TODO(owner): confirm, and add the form to `AGE_GATED_FORMS` if any other form is open to the general public.

Limits of the control: it is a checkbox attestation, not age verification. Vireek collects no date of birth. The attestation is enforced in the browser only and is not stored with the booking.

## 3. Deletion path

- Anyone (including a parent or guardian) can use `/data-request` (`DataRequestPage`, `src/lib/dsar.ts`, `dsarApi.ts`) and choose "delete". The form already verifies the email by code and tracks a response deadline (`DSAR_RESPONSE_DAYS`).
- The attestation shows a link to that page: "If a child's information was sent by mistake, ask us to delete it."
- When Vireek or a customer business learns a record belongs to a child: stop using it, then delete it through the same request flow.
- TODO(owner): name the person who handles these requests and the internal target time (the published deadline is `DSAR_RESPONSE_DAYS`).
- TODO(counsel): wording for a parent or guardian who is not the data subject (what proof, if any, to ask for).

## 4. Customer businesses

Businesses using Vireek decide whom they book. TODO(counsel): whether the customer agreement / DPA should state that the business must not use Vireek to collect data from children.

## 5. Open items

1. Counsel: age threshold per region; Terms eligibility clause; guardian-request wording; customer-agreement language.
2. Owner: request handler and target time; confirm no other public form needs the gate.
3. Engineering (optional): store the attestation with the booking server-side. `create_public_booking` was not modified here because its current definition spans several migrations and was not verified.

# Vireek documents — Phase 1 + 2

1. Copy `new/**` into the repo root (same relative paths).
2. `git apply patches/existing-files.diff`
3. ONLY if your repo's `src/lib/invoices.ts` has the broken `createInvoice` signature
   (duplicated `}): Promise<Invoice> {`, found in the uploaded ZIP): `git apply patches/invoices-syntax-fix.diff`
4. `npm run typecheck && npm run lint && npm test`
5. `npm run dev` -> http://localhost:5173/dev/documents (invoice, quote, receipt cases)

Rollback: `git revert` (no database/migration changes).

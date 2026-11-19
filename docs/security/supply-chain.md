# Supply chain: SBOM and build provenance

## What is produced
Workflow `.github/workflows/sbom-provenance.yml` runs when a GitHub release is published (or manually).
It runs `scripts/supply-chain/sbom.mjs` and publishes:

| Output | Where |
|---|---|
| `sbom/vireek.cdx.json` CycloneDX 1.5 JSON SBOM (all packages in `package-lock.json`, with SHA-512 integrity hashes, licences, purls, dependency graph) | workflow artifact `sbom-<commit>` (90 days) |
| `sbom/vireek.cdx.json.sha256` | same artifact |
| Same two files attached to the GitHub release (separate job, `contents: write` only, no `id-token`) | release assets |
| Build-provenance attestation for the SBOM (Sigstore, via `actions/attest-build-provenance`) | repository **Attestations** page |

Scope: the SBOM describes the npm dependency tree of the web app as locked. It does **not** cover Android/iOS
native dependencies, Supabase Edge Function (Deno) imports, or the container/OS layer. The attestation proves
*this repo's workflow produced this SBOM file*; it does not by itself prove the deployed app was built from it. [VERIFY]

## Generate locally
```bash
npm run sbom                                   # writes sbom/vireek.cdx.json (git-ignored)
node scripts/supply-chain/sbom.mjs --omit-dev  # production dependencies only
node scripts/supply-chain/sbom.mjs --check     # validate the lockfile, write nothing
node scripts/supply-chain/sbom.mjs --verify sbom/vireek.cdx.json   # structural self-check of a BOM (also run in CI)
npm run test:supply-chain                      # unit tests
```
Set `SOURCE_DATE_EPOCH` for a reproducible timestamp; the serial number is derived from the lockfile bytes.

## Verify a release SBOM
1. Download the artifact `sbom-<commit>` from the workflow run, and unzip it.
2. Check the checksum: `sha256sum -c vireek.cdx.json.sha256`
3. Verify the attestation (needs the GitHub CLI, authenticated):
   ```bash
   gh attestation verify vireek.cdx.json --repo <owner>/<repo>
   ```
   Expect `Verification succeeded`. Add `--signer-workflow <owner>/<repo>/.github/workflows/sbom-provenance.yml`
   to require that exact workflow. Add `--format json` to inspect the commit SHA and ref.
4. Confirm the commit in the attestation is the release commit.

## Pinning third-party actions
All `uses:` in this workflow must be full 40-character commit SHAs (tag in a trailing comment).
- Check offline: `node scripts/supply-chain/pin-actions.mjs --check .github/workflows/sbom-provenance.yml`
- Pin (network required): `node scripts/supply-chain/pin-actions.mjs --write .github/workflows/sbom-provenance.yml`
- The workflow itself runs `--check` and fails while any `PIN-ME` placeholder remains.
- Tags in the comments (`v4.2.2` etc.) are not verified; confirm they are the versions you want. [VERIFY]
- `.github/dependabot.yml` already has a `github-actions` ecosystem, so Dependabot will propose SHA bumps (it reads the `# vX.Y.Z` comment).
- Other workflows still use floating tags (`@v4`); pinning them is a separate change.

## Requirements and limits
- The attestation step needs a repository plan/visibility that supports artifact attestations. [VERIFY]
- Known lockfile drift (`docs/governance/DECISIONS_NEEDED.md` D-1) means the SBOM can be incomplete until resolved.
- `package.json` also references `scripts/supply-chain/license-check.mjs` and `asset-inventory.mjs`; neither exists
  and they were not created here (CHANGELOG claims them as done).

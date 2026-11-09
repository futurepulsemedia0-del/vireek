# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: the web app is continuously deployed from `main`; mobile releases are tagged `mobile-v*` (see `docs/MOBILE_RELEASE.md`).

Add one line per user-visible or operator-visible change under **Unreleased** in every PR. At release time, move entries under a dated heading.

## [Unreleased]

### Added
- Governance: CODEOWNERS by area (fixed invalid line), risk-checklist PR template, ADRs 0002-0011, dependency doctor, module-boundary and cycle ratchet, tech-debt register, licence policy gate, CycloneDX SBOM, asset licence inventory, business registers (commitments, sub-processors, policy calendar), release-notes automation. See `docs/governance/README.md`.
- Documentation set: catalogs (`docs/generated/*`), runbooks, policies (drafts), READMEs, GitHub templates.
- Module entitlements: per-account module access (off/trial/on, expiry, source) with `useEntitlement`, `ModuleGate`, server `requireEntitlement`, `/staff/entitlements` admin UI and an append-only audit log. Default off; every existing account keeps `core`. See `docs/ENTITLEMENTS.md`.

### Changed
### Fixed
### Security
- Module access is default-deny; tenants cannot write entitlements and cannot read other accounts' rows (RLS + staff-only RPCs).
> History before this file was created is not reconstructed here. See `CHANGES.md` and `IMPLEMENTATION_NOTES.md` for earlier notes.

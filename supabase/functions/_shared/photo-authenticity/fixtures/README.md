# Fixtures for photo-authenticity tests

## Real C2PA files (third-party, unmodified copies)
Source: https://github.com/contentauth/c2pa-rs, `sdk/tests/fixtures/` (Content Authenticity Initiative; dual-licensed MIT / Apache-2.0).
They are signed with the **C2PA test certificate**, so in production configuration their signer is not trusted; they are only test inputs.

| File here | Upstream name | Expected result of the reader |
|---|---|---|
| `c2pa-valid-test-signer.jpg` | `C.jpg` | validation valid; declares `algorithmicMedia` (generated gradient) |
| `c2pa-asset-tampered.jpg` | `XCA.jpg` | invalid, code `assertion.dataHash.mismatch` |
| `c2pa-signature-broken.jpg` | `E-sig-CA.jpg` | invalid, code `claimSignature.mismatch` |
| `c2pa-test-trust-anchors.pem` | `certs/trust/test_cert_root_bundle.pem` | test-only trust roots; with them `c2pa-valid-test-signer.jpg` becomes `trusted`. **Never use as production anchors.** |

## Synthetic samples (generated, deterministic)
`node --experimental-strip-types supabase/functions/_shared/photo-authenticity/fixtures/build-samples.ts` rewrites the `sample-*.jpg` files
from `testkit.ts` (a real 16x12 JPEG plus hand-built EXIF/XMP segments). They contain no personal data.

# Border-radius audit (Phase 0)

Scanned 1444 files, 10182 radius tokens (tests excluded).

## By size
| size | uses | % |
|---|---:|---:|
| rounded | 536 | 5.3% |
| rounded-sm | 54 | 0.5% |
| rounded-lg | 107 | 1.1% |
| rounded-xl | 130 | 1.3% |
| rounded-2xl | 40 | 0.4% |
| rounded-3xl | 29 | 0.3% |
| rounded-full | 2471 | 24.3% |
| rounded-control | 3457 | 34.0% |
| rounded-chip | 134 | 1.3% |
| rounded-surface | 3028 | 29.7% |
| rounded-overlay | 181 | 1.8% |
| arbitrary | 13 | 0.1% |
| rounded-none | 2 | 0.0% |

xl+2xl+3xl together: 199 uses (2.0%).

## By role × size
| role | total | bare | sm | lg | xl | 2xl | 3xl | full | control | chip | surface | overlay | arbitrary | none |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| button | 2875 | 155 | · | · | · | · | · | 342 | 2378 | · | · | · | · | · |
| input | 1074 | 127 | · | · | · | · | · | 8 | 939 | · | · | · | · | · |
| tab | 143 | · | · | · | · | · | · | 54 | 89 | · | · | · | · | · |
| chip | 1412 | 38 | · | · | · | · | · | 1240 | · | 134 | · | · | · | · |
| menu-item | 57 | 3 | · | · | · | · | · | 5 | 49 | · | · | · | · | · |
| tooltip | 1 | · | · | · | · | · | · | · | 1 | · | · | · | · | · |
| icon-tile | 2 | 2 | · | · | · | · | · | · | · | · | · | · | · | · |
| avatar | 176 | · | · | · | · | · | · | 176 | · | · | · | · | · | · |
| dot | 195 | · | · | · | · | · | · | 195 | · | · | · | · | · | · |
| progress | 320 | 7 | · | · | · | · | · | 313 | · | · | · | · | · | · |
| skeleton | 313 | 51 | · | 20 | · | · | · | 8 | · | · | 232 | · | 1 | 1 |
| image | 43 | 14 | 4 | · | · | · | · | 25 | · | · | · | · | · | · |
| callout | 11 | 2 | 5 | · | · | · | · | 3 | 1 | · | · | · | · | · |
| inset | 10 | 10 | · | · | · | · | · | · | · | · | · | · | · | · |
| card | 1955 | 10 | 12 | · | · | · | · | 17 | · | · | 1914 | · | 2 | · |
| panel | 883 | 8 | 3 | · | · | · | · | 3 | · | · | 864 | · | 5 | · |
| dropdown | 15 | · | · | · | · | · | · | · | · | · | 15 | · | · | · |
| toast | 5 | 1 | · | · | · | · | · | 1 | · | · | 3 | · | · | · |
| modal | 161 | · | · | · | · | · | · | · | · | · | · | 160 | · | 1 |
| sheet | 21 | · | · | · | · | · | · | · | · | · | · | 21 | · | · |
| focus-ring | 114 | 71 | 8 | 22 | 4 | 7 | · | · | · | · | · | · | 2 | · |
| other | 396 | 37 | 22 | 65 | 126 | 33 | 29 | 81 | · | · | · | · | 3 | · |

## Visual outliers
- **2xl-small** — 0 uses in 0 files — rounded-2xl/3xl/arbitrary>12px on a SMALL element (button, input, tab, chip, tile, callout…)
- **3xl** — 29 uses in 29 files — rounded-3xl (only an allow-listed hero may keep it)
  top: src/pages/AIReceptionistVsHumanPage.tsx (1), src/pages/AboutPage.tsx (1), src/pages/AffiliatePage.tsx (1)
- **full-on-rect** — 46 uses in 31 files — rounded-full on a surface/overlay/image (not circular, not a pill)
  top: src/components/gallery/PhotoLightbox.tsx (6), src/components/team/TechnicianPhotoEditor.tsx (3), src/pages/WarrantyClaimRecoveryPage.tsx (3)
- **full-pill-button** — 362 uses in 273 files — rounded-full on a button/input (pill-shaped, not circular) — needs a deliberate keep/drop decision
  top: src/pages/OperationsCenterPage.tsx (7), src/pages/DecisionLedgerPage.tsx (6), src/pages/CollectionsPage.tsx (5)
- **md-inversion** — 0 uses in 0 files — rounded-md (renders 12px today, i.e. LARGER than rounded-lg 8px)
- **bare-rounded-surface** — 18 uses in 13 files — bare `rounded` (4px) on a card/panel/modal
  top: src/components/chatWidget/ChatWidgetPreview.tsx (3), src/components/protection/FinancialsPanel.tsx (2), src/pages/StateOfCallsReportPage.tsx (2)
- **arbitrary** — 13 uses in 5 files — arbitrary radius values (violate "no arbitrary radii")
  top: src/components/wallboard/WallboardPanels.tsx (7), src/components/sections/LiveDemo.tsx (2), src/pages/WallboardPage.tsx (2)
- **sharp-surface** — 16 uses in 10 files — sm/none on a card/panel/modal/button/input
  top: src/components/HomeOperatingBudgetCard.tsx (2), src/components/LifetimeServicePlanCard.tsx (2), src/components/LiveChatWidget.tsx (2)
- **md+lg in the same file** — 0 files render 12px "md" beside 8px "lg"
- **no hierarchy (child radius ≥ parent radius, same file)** — 62 of 360 measurable nested pairs (17%)
  e.g. src/components/EmbedWidgetCard.tsx:44 (rounded-surface inside rounded-surface); src/components/LeadSourceBreakdown.tsx:75 (rounded-surface inside rounded-surface); src/components/ReworkIntelligence.tsx:171 (rounded-surface inside rounded-surface); src/components/WarrantyIntelligence.tsx:152 (rounded-surface inside rounded-surface)

## Rendered-radius histogram: BEFORE vs PROJECTED AFTER (role mapping applied to this snapshot)
| rendered radius | before | after (projected) |
|---|---:|---:|
| 0px | 2 | 2 |
| 4px | 590 | 590 |
| 6px | 134 | 134 |
| 8px | 3564 | 3564 |
| 12px | 3158 | 3158 |
| 16px | 221 | 221 |
| 24px | 29 | 29 |
| 32px | 2 | 2 |
| full | 2471 | 2471 |
| other arbitrary px | 11 | 11 |

Tokens whose rendered radius would change: 0 of 10182 (0.0%). Projection assumes the classifier is right; Phase 2 reviews by batch.

Classification coverage: 96.1% classified by a rule; 396 tokens fell into `other` (listed by --list other).

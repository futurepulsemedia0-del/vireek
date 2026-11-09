# Border-radius audit (Phase 0)

Scanned 1497 files, 13034 radius tokens (tests excluded).

## By size
| size | uses | % |
|---|---:|---:|
| rounded | 536 | 4.1% |
| rounded-sm | 49 | 0.4% |
| rounded-md | 204 | 1.6% |
| rounded-lg | 2256 | 17.3% |
| rounded-xl | 4396 | 33.7% |
| rounded-2xl | 3022 | 23.2% |
| rounded-3xl | 82 | 0.6% |
| rounded-full | 2448 | 18.8% |
| arbitrary | 39 | 0.3% |
| rounded-none | 2 | 0.0% |

xl+2xl+3xl together: 7500 uses (57.5%).

## By role × size
| role | total | bare | sm | md | lg | xl | 2xl | 3xl | full | arbitrary | none |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| button | 2875 | 155 | · | 78 | 1121 | 1071 | 107 | 1 | 342 | · | · |
| input | 1074 | 127 | · | 22 | 302 | 614 | 1 | · | 8 | · | · |
| tab | 143 | · | · | 1 | 57 | 31 | · | · | 54 | · | · |
| chip | 1398 | 34 | · | 35 | 46 | 32 | 12 | · | 1239 | · | · |
| menu-item | 57 | 3 | · | · | 25 | 21 | 3 | · | 5 | · | · |
| tooltip | 1 | · | · | · | 1 | · | · | · | · | · | · |
| icon-tile | 742 | 2 | · | 8 | 124 | 351 | 257 | · | · | · | · |
| avatar | 176 | · | · | · | · | · | · | · | 176 | · | · |
| dot | 195 | · | · | · | · | · | · | · | 195 | · | · |
| progress | 320 | 7 | · | · | · | 4 | 18 | · | 291 | · | · |
| skeleton | 405 | 51 | · | 2 | 20 | 90 | 230 | 2 | 8 | 1 | 1 |
| image | 185 | 14 | 4 | 3 | 51 | 61 | 26 | 1 | 25 | · | · |
| callout | 1596 | 3 | 2 | 24 | 239 | 1189 | 136 | · | 3 | · | · |
| inset | 310 | 10 | · | · | 20 | 84 | 187 | 9 | · | · | · |
| card | 1955 | 11 | 12 | 5 | 101 | 528 | 1274 | 5 | 17 | 2 | · |
| panel | 884 | 9 | 3 | 2 | 62 | 187 | 566 | 21 | 3 | 31 | · |
| dropdown | 15 | · | · | · | · | 11 | 4 | · | · | · | · |
| toast | 5 | 1 | · | 1 | · | 2 | · | · | 1 | · | · |
| modal | 161 | · | · | · | · | 6 | 146 | 8 | · | · | 1 |
| sheet | 21 | · | · | · | · | · | 15 | 6 | · | · | · |
| focus-ring | 114 | 71 | 8 | 2 | 22 | 2 | 7 | · | · | 2 | · |
| other | 402 | 38 | 20 | 21 | 65 | 112 | 33 | 29 | 81 | 3 | · |

## Visual outliers
- **2xl-small** — 766 uses in 452 files — rounded-2xl/3xl/arbitrary>12px on a SMALL element (button, input, tab, chip, tile, callout…)
  top: src/pages/SettingsPage.tsx (12), src/pages/InventoryCountsPage.tsx (8), src/pages/PromiseTrackerPage.tsx (8)
- **3xl** — 82 uses in 65 files — rounded-3xl (only an allow-listed hero may keep it)
  top: src/components/sections/Emergencyintelligence.tsx (4), src/components/blog/ArticleBody.tsx (3), src/pages/PricingPage.tsx (3)
- **full-on-rect** — 46 uses in 31 files — rounded-full on a surface/overlay/image (not circular, not a pill)
  top: src/components/gallery/PhotoLightbox.tsx (6), src/components/team/TechnicianPhotoEditor.tsx (3), src/pages/WarrantyClaimRecoveryPage.tsx (3)
- **full-pill-button** — 362 uses in 273 files — rounded-full on a button/input (pill-shaped, not circular) — needs a deliberate keep/drop decision
  top: src/pages/OperationsCenterPage.tsx (7), src/pages/DecisionLedgerPage.tsx (6), src/pages/CollectionsPage.tsx (5)
- **md-inversion** — 204 uses in 109 files — rounded-md (renders 12px today, i.e. LARGER than rounded-lg 8px)
  top: src/components/jobs/JobCloseoutPanel.tsx (8), src/components/comments/CommentsPanel.tsx (7), src/components/technician/FieldCapturePanel.tsx (7)
- **bare-rounded-surface** — 20 uses in 15 files — bare `rounded` (4px) on a card/panel/modal
  top: src/components/chatWidget/ChatWidgetPreview.tsx (3), src/components/protection/FinancialsPanel.tsx (2), src/pages/StateOfCallsReportPage.tsx (2)
- **arbitrary** — 39 uses in 26 files — arbitrary radius values (violate "no arbitrary radii")
  top: src/components/wallboard/WallboardPanels.tsx (7), src/pages/BlogPage.tsx (3), src/components/sections/LiveDemo.tsx (2)
- **sharp-surface** — 16 uses in 10 files — sm/none on a card/panel/modal/button/input
  top: src/components/HomeOperatingBudgetCard.tsx (2), src/components/LifetimeServicePlanCard.tsx (2), src/components/LiveChatWidget.tsx (2)
- **md+lg in the same file** — 76 files render 12px "md" beside 8px "lg"
- **no hierarchy (child radius ≥ parent radius, same file)** — 217 of 931 measurable nested pairs (23%)
  e.g. src/components/AccessDenied.tsx:89 (rounded-2xl inside rounded-2xl); src/components/EmptyState.tsx:191 (rounded-2xl inside rounded-2xl); src/components/HomeIntelligenceGraphCard.tsx:366 (rounded-xl inside rounded-xl); src/components/agent-marketplace/PublisherPanel.tsx:185 (rounded-xl inside rounded-xl)

## Rendered-radius histogram: BEFORE vs PROJECTED AFTER (role mapping applied to this snapshot)
| rendered radius | before | after (projected) |
|---|---:|---:|
| 0px | 2 | 2 |
| 2px | 49 | 49 |
| 4px | 536 | 536 |
| 6px | 0 | 125 |
| 8px | 2256 | 6420 |
| 12px | 4600 | 3169 |
| 16px | 3022 | 221 |
| 24px | 82 | 29 |
| 32px | 28 | 2 |
| full | 2448 | 2470 |
| other arbitrary px | 11 | 11 |

Tokens whose rendered radius would change: 6831 of 13034 (52.4%). Projection assumes the classifier is right; Phase 2 reviews by batch.

Classification coverage: 96.9% classified by a rule; 402 tokens fell into `other` (listed by --list other).

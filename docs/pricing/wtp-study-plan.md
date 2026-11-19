# WTP study: proposed plan (draft for owner approval)

Status: **PROPOSAL. Nothing here has been approved, fielded or measured, and no result exists.** This
fills section 2 of [`wtp-study.md`](wtp-study.md) with defaults chosen for a first wave, so the study can
start without reopening every question. The owner must confirm or change each row before the first
invitation is sent. Rows marked **[OWNER]** cannot be decided from the repository.

Repository facts used below were read from `src/lib/pricing.ts` and `src/lib/verticalIntelligence.ts` in
the uploaded snapshot (may differ from the live code **[VERIFY]**): plans can be billed monthly or
annually, and plans differ in included voice minutes, seats and locations. Current prices are
deliberately not copied here, because any number shown to respondents anchors their answers.

## 1. Proposed decisions

| Decision | Proposal | Why |
|---|---|---|
| Decision the study informs | Choose the price range to test in a later controlled price experiment. It does not set list prices | The PSM gives an acceptable range, not demand (`wtp-study.md` section 1) |
| Offer priced in wave 1 | One package, described with its included minutes, seats and locations stated explicitly: `[PACKAGE]` **[OWNER]** | Plans differ on exactly these three dimensions, so an unstated one would be filled in differently by each respondent. Other packages get their own wave or sample |
| Billing unit | Per month, for one business | Monthly billing exists in the product; annual pricing is a separate question (discount framing) and is out of scope for wave 1 |
| Currency | One currency per wave: the currency of the market being sampled `[CURRENCY]` **[OWNER]** | Pooling currencies makes the curves meaningless |
| Analysed segments | At most three dimensions, declared now: (1) business size by seat band, (2) monthly inbound call volume band relative to the package's included minutes, (3) current customer versus not | These map to what the product actually varies (seats, minutes) and to the anchoring risk of existing customers |
| Trade or industry | Record it for quotas and description; do not analyse it as a segment in wave 1 | Splitting by trade shrinks every group; labels should follow the product's existing industry list (`business_profile.primary_industry`) **[VERIFY: locate the value list]** |
| Band edges | `[SEAT BAND EDGES]`, `[CALL VOLUME BAND EDGES]` **[OWNER]** | Must be fixed before fielding |
| Minimum valid responses | 100 per analysed group (rule of thumb **[VERIFY]**), then revised from the pilot's bootstrap interval width | `wtp-study.md` section 4.3 |
| Recruitment target | `target = groups x 100 / (1 - exclusion rate from the pilot)`, rounded up | Exclusions are only known after the pilot |
| Question order | Fixed, as in [`wtp-survey-instrument.md`](wtp-survey-instrument.md); no randomization | One order per dataset; revisit only with evidence **[VERIFY]** |
| Analysis flags | `--bootstrap 1000 --seed 1 --min-n 100 --exclude-straight-lining`; no `--strict-order` | Ties are common when people type round numbers; strict order would discard them. Straight-lining is excluded and counted. Record these in the study log |
| Export normalization | `normalize-survey-export.mjs` with the survey tool's declared decimal and thousands marks | Never rely on silent conversion |
| Reviewers and approver | `[REVIEWERS]` **[OWNER]** | |

## 2. Gate before fielding

Do not send the first invitation until every box is ticked by the owner.

- [ ] Section 1 rows marked [OWNER] filled in and recorded with a date
- [ ] Offer text written and read by someone outside the project (no price, no anchor, units stated)
- [ ] Consent text, contact basis, retention and incentive rules reviewed **[COUNSEL]**
- [ ] Panel or recruitment contract reviewed if a third party is used **[COUNSEL]**
- [ ] Pilot run (5 to 10 cognitive interviews plus a soft launch); pilot data kept out of the real file
- [ ] Export from the survey tool tested end to end: normalize, then analyse a pilot file
- [ ] Exclusion rules and the speeder threshold fixed from the pilot
- [ ] Decision rule written: what range outcome leads to what next step

## 3. Run order

1. Field the survey; export raw responses to the research system (not this repository).
2. Normalize: `node scripts/pricing/normalize-survey-export.mjs export.csv --map "<columns>" --decimal <dot|comma> --out clean.csv`
3. Analyse: `node scripts/pricing/van-westendorp.mjs clean.csv --bootstrap 1000 --seed 1 --min-n 100 --exclude-straight-lining --out-dir out/wtp`
4. Review exclusions and warnings first, then group sizes, then points and intervals.
5. Fill in the report table in `wtp-study.md` section 8 and the decision log.

## 4. Not decided here

Legal text, the survey tool, incentive amounts, the actual offer package and price bands, and any use of
the results in billing, entitlements, marketing or investor material. None of these is built or connected.

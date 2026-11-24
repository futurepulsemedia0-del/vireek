# Competitor IP monitoring routine

Status: DRAFT routine. Not legal advice. Anything that interprets what a competitor filed, published or shipped, and anything about what Vireek may or may not do in response, is **[COUNSEL]**. Sources, products and schedules below are **[VERIFY]** until someone has run them once and recorded the result.

## 1. Why and what this is not

Purpose: notice early when a competitor or newcomer files, publishes or ships something that could affect Vireek's freedom to operate, its marks, or its own filing and publication decisions, and feed what we learn back into disclosures (`01-invention-disclosure-template.md`) and defensive publications (`05-defensive-publication-criteria.md`).

This routine is **not**: a clearance or infringement analysis, a way to copy competitors, or a licence to read competitors' confidential material. Monitoring uses public sources only. Observations are recorded as facts; judgments belong to counsel.

## 2. Ground rules

1. **Public sources only.** No scraping that breaks a site's terms, no accounts created under false identity, no asking customers or ex-employees of a competitor for non-public information, no using material that looks leaked or confidential. If you come across such material, stop, do not copy or forward it, and tell the legal contact. **[COUNSEL]**
2. **Engineers and patents.** Whether engineers should read competitor patents, and in what circumstances, affects legal risk and is for counsel to set. Until counsel decides, only the legal contact and the designated reviewer read patent texts; engineers receive only a counsel-approved summary of what area to be aware of. **[COUNSEL]**
3. **Facts, not conclusions.** Log what the source says, the date, and the link. Do not write "infringes", "copies", "overlaps with our patent", "we are free to operate" or "not a risk".
4. **No clean-room shortcuts.** Do not paste competitor text, screenshots of non-public material, or competitor code into Vireek's repository, prompts, tickets, or design documents.
5. **Log retention and access.** The log is internal, access-limited to the legal contact, the designated reviewer and counsel. Retention: **[COUNSEL]**.
6. **No mention in customer or public channels.** Do not name a competitor's IP position in sales material, support replies, or posts without counsel approval. Competitor comparison claims go through `docs/claims-register.json`.

## 3. Roles

| Role | Responsibility | Assigned to |
| --- | --- | --- |
| Monitoring owner | Runs the routine, keeps the watch list and log, escalates triggers | **[assign]** (candidate: Engineering owner; `docs/OWNERS.md`) |
| Designated reviewer | Reads flagged items, adds context, prepares the quarterly summary | **[assign]** |
| Legal contact | Receives escalations, decides whether counsel is engaged | **[assign]** **[COUNSEL]** |
| Counsel | Interprets, advises on action | **[COUNSEL]** |
| Brand owner | Trademark and naming watch results (`BRAND_GOVERNANCE.md` §1) | **[assign]** |

## 4. Watch list and cadence

Keep the watch list itself in the private IP folder; the table below is the structure and the categories, not the list of names. Start with direct competitors named in the repository's positioning material (the field-service software and AI-receptionist products Vireek is compared with) and add adjacent players as they appear. **[VERIFY: confirm the competitor set with the founders; do not copy it from older documents without checking]**

| Stream | What to look at | Sources (public) | Cadence (internal choice, **[VERIFY]**) | Output |
| --- | --- | --- | --- | --- |
| Patent filings and grants | New publications and grants by watched companies and inventors in the relevant fields (voice AI for service businesses, scheduling and dispatch, field-service workflows, AI call handling) | Public patent databases such as Google Patents, the USPTO and EPO public search tools, WIPO PATENTSCOPE **[VERIFY: tools and what each covers]** | Monthly | Log rows with number, title, date, owner, link |
| Trademark filings | New filings for names close to Vireek or its modules in the classes and markets Vireek uses | The offices and databases in `03-trademark-clearance-checklist.md` §3, or a paid watch service chosen with counsel **[COUNSEL]** | Monthly, or continuous if a service is bought | Log rows with mark, owner, office, class, status, link |
| Product and feature releases | New features that resemble Vireek's differentiators | Competitor release notes, changelogs, public docs, public demos, pricing pages, app-store listings | Monthly | Log rows with date, link, what the page says |
| Public technical writing | Papers, blog posts, conference talks and open-source repositories from watched companies | Their blogs, preprint servers, conference programmes, public repositories | Quarterly | Log rows, plus any item that could be prior art for Vireek's own ideas |
| Legal events | Public litigation, oppositions, licensing announcements involving watched companies | Press releases, court dockets that are public, company filings **[VERIFY]** | Quarterly | Log rows |
| Vireek name and look-alikes | Use of "Vireek" or confusingly similar names, logos, or domains by others | Web search, app stores, domain registries, social platforms, marketplaces | Monthly | Log rows, forwarded to Brand owner |
| Inbound claims | Anyone writing to Vireek about IP (including takedown notices) | Support inbox, legal intake. Copyright takedowns follow the existing `/dmca` process | As received | Forward to legal contact the same day; see `docs/compliance/legal-request-process.md` for the handling pattern |

## 5. The log

One row per observation. Keep the log in the private IP folder as a spreadsheet or table with these columns:

| Column | Content |
| --- | --- |
| Log ID | `CM-YYYY-NNN` |
| Date observed | YYYY-MM-DD |
| Stream | One of the streams above |
| Subject company | Name as it appears in the source |
| Source and link | URL or document reference, plus date of the source |
| What the source says | One or two factual sentences in your own words (not quotes beyond a short phrase) |
| Relevance flag | **None / Watch / Escalate** (see §6) set by the monitoring owner. A flag is a triage label, not a legal view. |
| Related Vireek area | Product area or module, if obvious; else blank |
| Reviewed by / date | Designated reviewer |
| Counsel notified (y/n, date) | |
| Outcome | Closed, new disclosure opened (`INV-...`), defensive publication candidate (`DP-...`), trademark record opened, counsel advising |

## 6. Triage

| Flag | Meaning | What happens |
| --- | --- | --- |
| None | Public, not in Vireek's fields or markets, or purely informational | Logged only |
| Watch | In Vireek's field or markets and worth tracking | Reviewed in the next monthly review; may become Escalate |
| Escalate | Touches a Vireek product area, name, or planned launch in a way someone could reasonably ask counsel about | Legal contact within two business days **[VERIFY: internal target]**; counsel decides next steps. Pause any related public announcements until counsel replies. **[COUNSEL]** |

Examples of what to escalate, without judging them: a new patent publication in an area Vireek ships; a pending mark that looks close to Vireek or a module name in a market Vireek serves; a letter or message alleging IP issues; a competitor's public post describing a method Vireek also uses; a competitor's public announcement of a defensive publication or open-source release that could count as prior art.

## 7. Review rhythm

| When | What | Who |
| --- | --- | --- |
| Monthly (30 minutes) | Run the monthly streams, update flags, escalate | Monitoring owner |
| Quarterly | Summary for founders and counsel: counts by stream and flag, items escalated and outcomes, gaps in sources, whether the watch list and trademark classes still match the product. No counts are pre-filled here; they come from the log. | Designated reviewer |
| On trigger | Immediately: a launch of a new feature, a market entry, a new name, a funding or partnership process with an IP diligence request, or any inbound IP claim | Monitoring owner and legal contact |
| Yearly | Revisit sources, tools and the competitor set; confirm counsel is still comfortable with §2 rules | Legal contact and counsel **[COUNSEL]** |

## 8. Feeding the other IP processes

- A competitor public disclosure that is close to something Vireek is considering for defensive publication may change the decision (it could already be prior art, or it may make publication pointless). Send it to counsel with the disclosure ID. **[COUNSEL]**
- A competitor filing in an area where Vireek has unpublished work makes a prompt disclosure more urgent. Open or update the disclosure (`01-...`).
- A trademark hit becomes a clearance record under `03-trademark-clearance-checklist.md` §4, or an enforcement question for counsel.
- A competitor's new feature does not create a duty to respond. Product decisions follow the product roadmap, not this log.

## 9. Not done here

Valuation of competitor patents, freedom-to-operate opinions, invalidity analyses, licensing strategy and any contact with a competitor about IP are counsel's work, not part of this routine. **[COUNSEL]**

---
title: "Data Security: What to Ask Any AI Phone Vendor"
slug: ai-vendor-security-checklist
description: "Before an AI vendor answers your calls, ask where data lives, who can see it and how it is logged. A practical security checklist for home service owners."
category: compliance
tags: [security, ai-receptionist, vendor-evaluation]
author: vireek-team
publishedAt: 2026-09-05
updatedAt: 2026-11-15
featured: false
pillar: false
legalReview: true
relatedSlugs: [ai-receptionist-vs-answering-service, ai-receptionist-cost, call-recording-consent-ai-receptionist, cost-of-a-missed-call]
cta: { type: demo, heading: "Ask us these questions live", body: "Bring this checklist to a demo and ask how data is stored, isolated and logged." }
faq:
  - { q: "What sensitive data do home service calls contain?", a: "Names, home addresses, phone numbers, gate codes, schedules that reveal when a house is empty and sometimes payment details. That mix is more sensitive than most owners assume, so treat call data accordingly." }
  - { q: "Is a security badge or certification enough?", a: "It is a useful signal, not a substitute for asking specific questions. Ask what the certification covers, who audited it and whether the report is available under NDA." }
  - { q: "Where can I read how Vireek handles security?", a: "See the [security page](/security), the [privacy policy](/privacy) and the list of [subprocessors](/subprocessors). Ask for anything not published." }
  - { q: "Do I need a data processing agreement?", a: "If you handle personal data of customers in regions with privacy laws, a data processing agreement is commonly requested. Ask your counsel, and see Vireek's [DPA](/dpa)." }
---

Home service businesses collect more sensitive information than most people realize: home addresses, gate codes, schedules that reveal when a house is empty and sometimes payment details. Before handing any of that to a third-party AI vendor to answer your calls, it is worth asking a few direct questions.

This guide gives you a practical checklist, explains what a good answer looks like and flags the red flags. It is general information, not legal or security advice, and you should involve qualified professionals for your own situation.

## Why call data deserves extra care

A single phone call can contain a customer's full name, their street address, a description of when they are away and the details of a problem inside their home. Multiply that by thousands of calls and you have a rich dataset that would be valuable to the wrong person.

Three facts raise the stakes for home service businesses.

- The data is **personal**: it identifies real people at real addresses.
- The data is **operational**: schedules and access notes can show when a property is empty.
- The data is **yours to protect**: your customers trusted you, not the vendor, with it.

## 1. Where does the data actually live?

Ask whether caller data is encrypted both in transit and at rest, and whether it is stored in a way that is logically isolated per business. Isolation means one company's data cannot be queried alongside another's by mistake.

Vireek enforces this with database-level Row Level Security policies scoped to each account, not just application-level checks that could be bypassed by a bug. Whatever vendor you consider, ask how isolation is enforced and at which layer.

### What good answers sound like

- "Data is encrypted in transit and at rest."
- "Each account's data is isolated by policies enforced in the database itself."
- "Here is where data is stored and which providers process it."

### Red flags

- Vague claims with no mechanism.
- An inability to say where data is stored.
- No answer on isolation between customers.

## 2. Who on your own team can see what?

Not every team member needs the same visibility. A technician generally only needs to see the jobs assigned to them. An office manager may need the full call and lead history.

Ask whether the vendor supports role-based permissions, and whether sensitive account actions, such as changing someone's permissions or deleting a job, are recorded somewhere you can review later.

## 3. Is there an audit trail?

An audit trail answers the question "who did what, and when?" It matters when something goes wrong: a deleted record, an unexpected export or a permission change. Ask what is logged, how long logs are kept and whether you can see them yourself.

## 4. What happens to recordings and transcripts?

Call recordings and transcripts are some of the most sensitive data a vendor holds. Ask:

- Are calls recorded, transcribed or both, and can each be turned off?
- How long are they kept, and can you set retention?
- Can a customer's data be deleted on request?
- Who at the vendor can access call content, and is access logged?

Disclosure and consent are a separate topic. Read our guide to [call recording consent and AI disclosure](/blog/call-recording-consent-ai-receptionist) for the framework.

## 5. Who else touches the data?

Most software relies on subprocessors: cloud hosts, speech services, messaging providers and analytics tools. Each is a place where your data may travel. Ask for the list, and ask how you are notified of changes. Vireek publishes its [subprocessors](/subprocessors) for exactly this reason.

## 6. How are incidents handled?

No vendor is immune to problems. What matters is preparedness. Ask:

- Is there a documented incident response process?
- How and how quickly will you be notified if your data is affected?
- Is there a vulnerability disclosure process for researchers?

## The checklist

Use this list in every vendor conversation.

:::steps
1. Is data encrypted in transit and at rest?
2. Is my business's data logically isolated from every other customer's data, and at which layer?
3. Can I set different access levels for different team members?
4. Is there an audit trail for sensitive account changes, and can I review it?
5. What happens to call recordings and transcripts, and for how long are they kept?
6. Who are your subprocessors, and how will I be told about changes?
7. What is your incident notification process?
8. Can you provide a data processing agreement and security documentation?
:::

## Ask for specifics, not reassurance

"We take security seriously" is not an answer. It is a sentence every vendor says. A vendor that can describe specifically how access is restricted, how changes are logged and how long data is retained is one that has actually built these protections rather than simply claiming them.

Vireek's full security practices, including the audit log and account-level access controls, are documented on the [Security page](/security). Read them, then ask us anything they do not cover.

:::warning
Do not accept a verbal assurance for anything that matters. Ask for the answer in writing, in documentation or in your contract.
:::

## How to compare vendors fairly

Score each vendor on the same criteria, and weight the ones that matter most to you.

| Criterion | What to look for |
|---|---|
| Encryption | In transit and at rest, stated clearly |
| Isolation | Enforced in the database, not only the app |
| Access control | Role-based permissions you can configure |
| Audit logging | Sensitive actions recorded and reviewable |
| Retention | Configurable, with deletion on request |
| Subprocessors | Published list with change notices |
| Documentation | Security page, DPA and policies available |
| Transparency | Direct answers, in writing |

A vendor that scores well on the first four and is open about the rest is a strong candidate. A vendor that is evasive deserves caution, whatever its price.

## Security is also about your own habits

Even the best vendor cannot protect against weak practices on your side.

- Use strong, unique passwords and multi-factor authentication where available.
- Give each team member their own login.
- Remove access promptly when someone leaves.
- Review who has permissions each quarter.
- Be careful what you put in free-text notes, such as full payment card numbers.

## Putting it into your buying process

Security belongs alongside price and features in the decision, not after it. When comparing options, put the cost, the capabilities and the security answers in one document. Our [cost guide](/blog/ai-receptionist-cost) covers the price side, and the comparison of [AI receptionists and answering services](/blog/ai-receptionist-vs-answering-service) covers the rest. For the larger picture of what unanswered calls cost you, see [why every missed call is a lost job](/blog/cost-of-a-missed-call).

## What a good evaluation looks like in practice

Set aside an hour for each shortlisted vendor. Read their published security page first, then send your eight questions in writing and note how quickly and specifically they answer. A vendor who replies with documents and named mechanisms is showing you how they operate. A vendor who replies with marketing language is showing you something too. Ask one scenario question as well: "If an employee left on bad terms today, how would I remove their access and see what they touched?" The answer reveals whether permissions and audit logs work in practice. Keep the written answers in a shared folder so that the next review, a year from now, starts from evidence and not from memory.

Finally, revisit the answers whenever something material changes: a new feature that touches call data, a new subprocessor, a change in your own team or a new region you serve. Security is a standing practice, not a one-time purchase decision, and a short annual review keeps it that way.

If you operate in several regions, ask each vendor whether data location can be chosen and whether privacy rights requests, such as access or deletion, are supported through a documented process. Those two answers tell you a great deal about operational maturity.

:::takeaways
- Call data is personal, operational and your responsibility.
- Ask where data lives, how it is encrypted and how businesses are isolated.
- Use role-based access and review the audit trail.
- Know what is recorded, how long it is kept and who can access it.
- Request the subprocessor list and the incident process.
- Get answers in writing and compare vendors on the same criteria.
:::

## Next step

Take the eight questions to your shortlist and compare the answers. You can read how Vireek approaches each one on the [Security page](/security), and [book a demo](/demo) to ask your own questions directly.

:::cta type=demo heading="Bring the checklist to a demo" button="Book a demo"
Ask how data is stored, isolated and logged, and get the answers in writing.
:::

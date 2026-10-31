# Vireek voice and tone

**Clear, warm, confident, concise.** Write like a capable colleague, not a system.

## Rules
1. **Plain English.** Short words, short sentences. No jargon ("payload", "entity", "instance").
2. **Active voice.** "We couldn't save your changes." not "Changes could not be saved."
3. **No blame.** Never "You entered an invalid…". Say what to do: "Enter a date in the future."
4. **Say what happened, then what to do next.** Every error has a next step.
5. **Sentence case** for all UI text: "Save changes", not "Save Changes".
6. **No filler or panic.** Banned: "Oops!", "Whoops", "Uh-oh", "Yikes", "Something went wrong" on its own.
7. **No raw codes or ALL CAPS.** Show a friendly message; put the incident/reference ID in a secondary line.
8. **One exclamation mark per screen at most**, only for real celebration.
9. **Use the customer's words** (job, customer, quote), not internal names.

## Message catalog pattern
Keys live in the `dashboard` namespace under `messages.<kind>.<id>.<part>`:

| Kind | Parts | Example |
| --- | --- | --- |
| `error` | `title`, `body`, `action` | "We couldn't save your changes" / "Check your connection and try again." / "Try again" |
| `success` | `title` | "Changes saved" |
| `empty` | `title`, `body`, `action` | "No quotes yet" / "Create a quote to send it to a customer." / "New quote" |
| `confirm` | `title`, `body`, `confirm`, `cancel` | "Delete this job?" / "This can't be undone." / "Delete job" / "Keep job" |

Use `messageKey()` from `src/lib/messageCatalog.ts`, so keys stay typed and greppable. Destructive confirm buttons name the action ("Delete job"), never "Yes"/"OK".

## Long text
Names, emails, IDs: one line, ellipsis, full text on hover/focus (`<TruncatedText kind="name">`).
Addresses: two lines. Notes: three lines plus "Show more". Every flex/grid child holding user text gets `min-w-0`.
Test layouts with German, Finnish, Persian, a 200-character string, and `pseudoLocalize()` (+40% length).

## Dates, times, numbers
Never call `toLocaleString`/`Intl.*` directly; use `@/lib/format` or `useFormat()`.
Schedules show the business time zone, plus the viewer's when different: "9:00 AM CT (your time 10:00 AM ET)" via `<ZonedTime>`.
Relative times use `<RelativeTime>` ("5 minutes ago", exact time on hover); after 7 days show the date.

## Enforced by
`npm run lint:voice` (filler, raw codes, ALL CAPS), `npm run lint:locale` (no new raw Intl), `npm run i18n:keys` (missing keys).

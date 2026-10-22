/* ------------------------------------------------------------------ */
/*  Holiday calendars + business-day maths, table-driven and computed  */
/*  (no yearly maintenance for movable feasts). Dates are 'YYYY-MM-DD' */
/*  strings handled in UTC, so no timezone can shift a holiday.        */
/*                                                                      */
/*  Coverage is explicit per country (see calendarInfo): full national */
/*  calendars for the US, CA, GB, AU and 13 EU states; a minimal       */
/*  New-Year/Christmas set for the rest. Regional/local closures can   */
/*  always be added per tenant as custom closures.                     */
/* ------------------------------------------------------------------ */

export type HolidayKind = 'public' | 'bank' | 'observance';
export interface Holiday {
  date: string;
  name: string;
  kind: HolidayKind;
  /** Subdivisions it applies to; undefined = nationwide. */
  regions?: string[];
  /** Original date when the day was moved (weekend substitution). */
  observedFrom?: string;
}
export interface CustomClosure { date: string; closed: boolean; name?: string }
export type Coverage = 'full' | 'national_core' | 'minimal';

/* ------------------------------ date utils -------------------------- */

const pad = (n: number) => String(n).padStart(2, '0');
export const isoDate = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const toUtc = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const fromUtc = (ms: number) => { const dt = new Date(ms); return isoDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()); };
export const addDays = (iso: string, n: number) => fromUtc(toUtc(iso) + n * 86_400_000);
export const weekday = (iso: string) => new Date(toUtc(iso)).getUTCDay(); // 0 = Sunday
export const isValidIso = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && fromUtc(toUtc(s)) === s;

/** Western (Gregorian) Easter Sunday. */
export function easterSunday(year: number): string {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return isoDate(year, month, day);
}

function nthWeekday(y: number, m: number, wd: number, n: number): string {
  if (n > 0) {
    const first = isoDate(y, m, 1);
    return addDays(first, ((wd - weekday(first) + 7) % 7) + (n - 1) * 7);
  }
  const last = isoDate(y, m, new Date(Date.UTC(y, m, 0)).getUTCDate());
  return addDays(last, -((weekday(last) - wd + 7) % 7));
}
const firstOnOrAfter = (y: number, m: number, d: number, wd: number) => { const s = isoDate(y, m, d); return addDays(s, (wd - weekday(s) + 7) % 7); };
const lastBefore = (y: number, m: number, d: number, wd: number) => { const s = addDays(isoDate(y, m, d), -1); return addDays(s, -((weekday(s) - wd + 7) % 7)); };

/* -------------------------------- rules ----------------------------- */

/**
 * Rule syntax:  'MM-DD' fixed | 'E+N'/'E-N' Easter offset | 'N:m:wd:n' nth weekday (n=-1 last)
 *               'A:m:d:wd' first weekday on/after | 'B:m:d:wd' last weekday before
 */
interface Rule { r: string | ((y: number) => string); name: string; kind?: HolidayKind; regions?: string[]; noShift?: boolean }
const R = (r: Rule['r'], name: string, extra: Partial<Rule> = {}): Rule => ({ r, name, ...extra });

function resolve(rule: Rule, year: number): string {
  if (typeof rule.r === 'function') return rule.r(year);
  const s = rule.r;
  if (/^\d{2}-\d{2}$/.test(s)) return `${year}-${s}`;
  const e = /^E([+-]\d+)$/.exec(s);
  if (e) return addDays(easterSunday(year), Number(e[1]));
  const p = s.split(':');
  const [m, a, b] = [Number(p[1]), Number(p[2]), Number(p[3])];
  if (p[0] === 'N') return nthWeekday(year, m, a, b);
  if (p[0] === 'A') return firstOnOrAfter(year, m, a, b);
  if (p[0] === 'B') return lastBefore(year, m, a, b);
  throw new Error(`Bad holiday rule ${s}`);
}

type ShiftMode = 'none' | 'next' | 'usfed';
interface Calendar { coverage: Coverage; note?: string; shift: ShiftMode; rules: Rule[]; defaultRegion?: string }

const NH = (n: string) => R('01-01', n);
const XMAS = (): Rule[] => [R('12-25', 'Christmas Day'), R('12-26', 'Boxing Day / St Stephen’s Day')];
const EASTER_CORE = (): Rule[] => [R('E-2', 'Good Friday'), R('E+1', 'Easter Monday')];

const FAMILY_DAY = (name: string, regions: string[]) => R('N:2:1:3', name, { regions });

const CA_RULES: Rule[] = [
  NH('New Year’s Day'), R('E-2', 'Good Friday'), R('07-01', 'Canada Day'), R('N:9:1:1', 'Labour Day'), R('12-25', 'Christmas Day'),
  R('B:5:25:1', 'Victoria Day', { regions: ['AB', 'BC', 'MB', 'NT', 'NU', 'ON', 'SK', 'YT'] }),
  R('B:5:25:1', 'National Patriots’ Day', { regions: ['QC'] }),
  R('N:10:1:2', 'Thanksgiving', { regions: ['AB', 'BC', 'MB', 'NT', 'NU', 'ON', 'QC', 'SK', 'YT'] }),
  FAMILY_DAY('Family Day', ['AB', 'BC', 'ON', 'SK', 'NB']),
  FAMILY_DAY('Louis Riel Day', ['MB']), FAMILY_DAY('Heritage Day', ['NS']), FAMILY_DAY('Islander Day', ['PE']),
  R('06-24', 'Saint-Jean-Baptiste Day', { regions: ['QC'], noShift: true }),
  R('09-30', 'National Day for Truth and Reconciliation', { regions: ['BC', 'NT', 'NU', 'PE', 'YT'] }),
  R('11-11', 'Remembrance Day', { regions: ['AB', 'BC', 'NB', 'NL', 'NT', 'NU', 'PE', 'SK', 'YT'], noShift: true }),
  R('12-26', 'Boxing Day', { regions: ['ON'] }),
  R('N:8:1:1', 'Civic Holiday / Provincial Day', { regions: ['BC', 'NB', 'NS', 'NT', 'NU', 'ON', 'SK'], kind: 'observance' }),
];

const AU_ALL = ['ACT', 'NSW', 'NT', 'QLD', 'SA', 'TAS', 'VIC', 'WA'];
const AU_RULES: Rule[] = [
  NH('New Year’s Day'), R('01-26', 'Australia Day'), R('E-2', 'Good Friday'), R('E+1', 'Easter Monday'),
  R('04-25', 'Anzac Day', { noShift: true }), R('12-25', 'Christmas Day'), R('12-26', 'Boxing Day'),
  R('E-1', 'Easter Saturday', { regions: ['ACT', 'NSW', 'NT', 'QLD', 'SA', 'VIC'] }),
  R('N:6:1:2', 'King’s Birthday', { regions: ['ACT', 'NSW', 'NT', 'SA', 'TAS', 'VIC'] }),
  R('N:10:1:1', 'King’s Birthday', { regions: ['QLD'] }),
  R('N:9:1:-1', 'King’s Birthday (usually proclaimed — confirm)', { regions: ['WA'] }),
  R('N:10:1:1', 'Labour Day', { regions: ['ACT', 'NSW', 'SA'] }), R('N:3:1:2', 'Labour Day / Eight Hours Day', { regions: ['VIC', 'TAS'] }),
  R('N:3:1:1', 'Labour Day', { regions: ['WA'] }), R('N:5:1:1', 'Labour Day / May Day', { regions: ['NT', 'QLD'] }),
  R('N:6:1:1', 'Western Australia Day', { regions: ['WA'] }),
];

const DE_RULES: Rule[] = [
  NH('New Year’s Day'), R('E-2', 'Good Friday'), R('E+1', 'Easter Monday'), R('05-01', 'Labour Day'), R('E+39', 'Ascension Day'),
  R('E+50', 'Whit Monday'), R('10-03', 'German Unity Day'), R('12-25', 'Christmas Day'), R('12-26', 'Second Day of Christmas'),
  R('01-06', 'Epiphany', { regions: ['BW', 'BY', 'ST'] }), R('03-08', 'International Women’s Day', { regions: ['BE', 'MV'] }),
  R('E+60', 'Corpus Christi', { regions: ['BW', 'BY', 'HE', 'NW', 'RP', 'SL'] }), R('08-15', 'Assumption Day', { regions: ['SL'] }),
  R('10-31', 'Reformation Day', { regions: ['BB', 'HB', 'HH', 'MV', 'NI', 'SH', 'SN', 'ST', 'TH'] }),
  R('11-01', 'All Saints’ Day', { regions: ['BW', 'BY', 'NW', 'RP', 'SL'] }),
  R((y) => lastBefore(y, 11, 23, 3), 'Day of Repentance and Prayer', { regions: ['SN'] }),
  R('09-20', 'World Children’s Day', { regions: ['TH'] }),
];

const ASSUMPTION = () => R('08-15', 'Assumption Day');
const ALL_SAINTS = () => R('11-01', 'All Saints’ Day');

const CALENDARS: Record<string, Calendar> = {
  US: {
    coverage: 'full', shift: 'usfed',
    rules: [
      NH('New Year’s Day'), R('N:1:1:3', 'Martin Luther King Jr. Day'), R('N:2:1:3', 'Washington’s Birthday'), R('N:5:1:-1', 'Memorial Day'),
      R('06-19', 'Juneteenth'), R('07-04', 'Independence Day'), R('N:9:1:1', 'Labor Day'), R('N:10:1:2', 'Columbus / Indigenous Peoples’ Day'),
      R('11-11', 'Veterans Day'), R('N:11:4:4', 'Thanksgiving'), R('12-25', 'Christmas Day'),
    ],
    note: 'Federal holidays. State and local days (e.g. Patriots’ Day, Texas Independence Day) are not included — add them as custom closures.',
  },
  CA: { coverage: 'full', shift: 'next', rules: CA_RULES, note: 'Choose a province for provincial days. Provincial statutory rules vary by employer type — verify before relying on them for payroll.' },
  GB: {
    coverage: 'full', shift: 'next', defaultRegion: 'ENG',
    rules: [
      NH('New Year’s Day'), R('01-02', '2 January', { regions: ['SCT'] }), R('E-2', 'Good Friday'),
      R('E+1', 'Easter Monday', { regions: ['ENG', 'WLS', 'NIR'] }), R('N:5:1:1', 'Early May bank holiday'), R('N:5:1:-1', 'Spring bank holiday'),
      R('N:8:1:-1', 'Summer bank holiday', { regions: ['ENG', 'WLS', 'NIR'] }), R('N:8:1:1', 'Summer bank holiday', { regions: ['SCT'] }),
      R('11-30', 'St Andrew’s Day', { regions: ['SCT'] }), R('03-17', 'St Patrick’s Day', { regions: ['NIR'] }),
      R('07-12', 'Battle of the Boyne', { regions: ['NIR'] }), ...XMAS().map((x) => ({ ...x, name: x.name.startsWith('Boxing') ? 'Boxing Day' : x.name })),
    ],
    note: 'The UK government can add one-off bank holidays — add them as custom closures.',
  },
  AU: { coverage: 'full', shift: 'next', rules: AU_RULES, note: 'Choose a state/territory for state days. Local show days and regional holidays are not included.' },
  DE: { coverage: 'full', shift: 'none', rules: DE_RULES, note: 'Choose a Bundesland for state holidays (BY, NW, …).' },
  FR: { coverage: 'full', shift: 'none', rules: [NH('New Year’s Day'), R('E+1', 'Easter Monday'), R('05-01', 'Labour Day'), R('05-08', 'Victory in Europe Day'), R('E+39', 'Ascension Day'), R('E+50', 'Whit Monday'), R('07-14', 'Bastille Day'), ASSUMPTION(), ALL_SAINTS(), R('11-11', 'Armistice Day'), R('12-25', 'Christmas Day')], note: 'Alsace-Moselle extra days (Good Friday, 26 December) are not included.' },
  ES: { coverage: 'national_core', shift: 'none', rules: [NH('New Year’s Day'), R('01-06', 'Epiphany'), R('E-2', 'Good Friday'), R('05-01', 'Labour Day'), ASSUMPTION(), R('10-12', 'National Day'), ALL_SAINTS(), R('12-06', 'Constitution Day'), R('12-08', 'Immaculate Conception'), R('12-25', 'Christmas Day')], note: 'Autonomous-community and local holidays are not included.' },
  IT: { coverage: 'full', shift: 'none', rules: [NH('New Year’s Day'), R('01-06', 'Epiphany'), R('E+1', 'Easter Monday'), R('04-25', 'Liberation Day'), R('05-01', 'Labour Day'), R('06-02', 'Republic Day'), R('08-15', 'Ferragosto'), ALL_SAINTS(), R('12-08', 'Immaculate Conception'), R('12-25', 'Christmas Day'), R('12-26', 'St Stephen’s Day')], note: 'Patron-saint days are local and not included.' },
  NL: { coverage: 'full', shift: 'none', rules: [NH('New Year’s Day'), R('E-2', 'Good Friday', { kind: 'observance' }), R('E+1', 'Easter Monday'), R((y) => (weekday(isoDate(y, 4, 27)) === 0 ? isoDate(y, 4, 26) : isoDate(y, 4, 27)), 'King’s Day'), R('05-05', 'Liberation Day', { kind: 'observance' }), R('E+39', 'Ascension Day'), R('E+50', 'Whit Monday'), ...XMAS()] },
  IE: { coverage: 'full', shift: 'none', rules: [NH('New Year’s Day'), R((y) => (weekday(isoDate(y, 2, 1)) === 5 ? isoDate(y, 2, 1) : nthWeekday(y, 2, 1, 1)), 'St Brigid’s Day'), R('03-17', 'St Patrick’s Day'), R('E+1', 'Easter Monday'), R('N:5:1:1', 'May bank holiday'), R('N:6:1:1', 'June bank holiday'), R('N:8:1:1', 'August bank holiday'), R('N:10:1:-1', 'October bank holiday'), R('12-25', 'Christmas Day'), R('12-26', 'St Stephen’s Day')] },
  AT: { coverage: 'full', shift: 'none', rules: [NH('New Year’s Day'), R('01-06', 'Epiphany'), R('E+1', 'Easter Monday'), R('05-01', 'Labour Day'), R('E+39', 'Ascension Day'), R('E+50', 'Whit Monday'), R('E+60', 'Corpus Christi'), ASSUMPTION(), R('10-26', 'National Day'), ALL_SAINTS(), R('12-08', 'Immaculate Conception'), ...XMAS()] },
  BE: { coverage: 'full', shift: 'none', rules: [NH('New Year’s Day'), R('E+1', 'Easter Monday'), R('05-01', 'Labour Day'), R('E+39', 'Ascension Day'), R('E+50', 'Whit Monday'), R('07-21', 'National Day'), ASSUMPTION(), ALL_SAINTS(), R('11-11', 'Armistice Day'), R('12-25', 'Christmas Day')] },
  PT: { coverage: 'full', shift: 'none', rules: [NH('New Year’s Day'), R('E-2', 'Good Friday'), R('04-25', 'Freedom Day'), R('05-01', 'Labour Day'), R('E+60', 'Corpus Christi'), R('06-10', 'Portugal Day'), ASSUMPTION(), R('10-05', 'Republic Day'), ALL_SAINTS(), R('12-01', 'Restoration of Independence'), R('12-08', 'Immaculate Conception'), R('12-25', 'Christmas Day')] },
  PL: { coverage: 'full', shift: 'none', rules: [NH('New Year’s Day'), R('01-06', 'Epiphany'), R('E+1', 'Easter Monday'), R('05-01', 'Labour Day'), R('05-03', 'Constitution Day'), R('E+60', 'Corpus Christi'), ASSUMPTION(), ALL_SAINTS(), R('11-11', 'Independence Day'), R('12-24', 'Christmas Eve'), ...XMAS()] },
  DK: { coverage: 'full', shift: 'none', rules: [NH('New Year’s Day'), R('E-3', 'Maundy Thursday'), R('E-2', 'Good Friday'), R('E+1', 'Easter Monday'), R('E+39', 'Ascension Day'), R('E+50', 'Whit Monday'), ...XMAS()] },
  SE: { coverage: 'national_core', shift: 'none', rules: [NH('New Year’s Day'), R('01-06', 'Epiphany'), R('E-2', 'Good Friday'), R('E+1', 'Easter Monday'), R('05-01', 'Labour Day'), R('E+39', 'Ascension Day'), R('06-06', 'National Day'), R('A:6:19:5', 'Midsummer Eve', { kind: 'observance' }), ...XMAS()], note: 'Midsummer Eve and Christmas Eve are de-facto days off; Midsummer Eve is listed as an observance.' },
  FI: { coverage: 'national_core', shift: 'none', rules: [NH('New Year’s Day'), R('01-06', 'Epiphany'), R('E-2', 'Good Friday'), R('E+1', 'Easter Monday'), R('05-01', 'May Day'), R('E+39', 'Ascension Day'), R('A:6:19:5', 'Midsummer Eve', { kind: 'observance' }), R('12-06', 'Independence Day'), ...XMAS()] },
};

const MINIMAL: Calendar = {
  coverage: 'minimal', shift: 'none', rules: [NH('New Year’s Day'), R('12-25', 'Christmas Day')],
  note: 'Only New Year’s Day and Christmas Day are built in for this country. Add national holidays as custom closures.',
};

export const DE_STATES: Readonly<Record<string, string>> = {
  BW: 'Baden-Württemberg', BY: 'Bavaria', BE: 'Berlin', BB: 'Brandenburg', HB: 'Bremen', HH: 'Hamburg', HE: 'Hesse',
  MV: 'Mecklenburg-Vorpommern', NI: 'Lower Saxony', NW: 'North Rhine-Westphalia', RP: 'Rhineland-Palatinate', SL: 'Saarland',
  SN: 'Saxony', ST: 'Saxony-Anhalt', SH: 'Schleswig-Holstein', TH: 'Thuringia',
};

export function calendarInfo(country: string): { coverage: Coverage; note?: string } {
  const c = CALENDARS[country.toUpperCase()] ?? MINIMAL;
  return { coverage: c.coverage, note: c.note };
}

/* ------------------------------ generation -------------------------- */

function shiftDates(entries: { rule: Rule; date: string }[], mode: ShiftMode): { date: string; observedFrom?: string }[] {
  if (mode === 'none') return entries.map((e) => ({ date: e.date }));
  const fixed = (e: { rule: Rule }) => typeof e.rule.r === 'string' && /^\d{2}-\d{2}$/.test(e.rule.r) && !e.rule.noShift;
  const isWeekend = (d: string) => weekday(d) === 0 || weekday(d) === 6;
  const taken = new Set(entries.filter((e) => !isWeekend(e.date)).map((e) => e.date));
  return entries.map((e) => {
    if (!fixed(e) || !isWeekend(e.date)) return { date: e.date };
    let target: string;
    if (mode === 'usfed') target = addDays(e.date, weekday(e.date) === 6 ? -1 : 1);
    else {
      target = e.date;
      do { target = addDays(target, 1); } while (isWeekend(target) || taken.has(target));
      taken.add(target);
    }
    return { date: target, observedFrom: e.date };
  });
}

/** Holidays that apply in `country` (and `subdivision`) during `year`, soonest first. */
export function holidaysFor(country: string, year: number, subdivision?: string | null): Holiday[] {
  const cal = CALENDARS[country.toUpperCase()] ?? MINIMAL;
  const sub = (subdivision?.toUpperCase() || cal.defaultRegion || '') as string;
  const applicable = cal.rules.filter((r) => !r.regions || (sub && r.regions.includes(sub)));
  // Resolve neighbours too so year-boundary substitutions (e.g. US New Year on a Saturday) land correctly.
  const out: Holiday[] = [];
  for (const y of [year - 1, year, year + 1]) {
    const resolved = applicable.map((rule) => ({ rule, date: resolve(rule, y) }));
    const shifted = shiftDates(resolved, cal.shift);
    resolved.forEach((e, i) => {
      const s = shifted[i];
      if (s.date.slice(0, 4) !== String(year)) return;
      out.push({ date: s.date, name: e.rule.name, kind: e.rule.kind ?? 'public', regions: e.rule.regions, observedFrom: s.observedFrom });
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
}

/* --------------------------- business-day maths --------------------- */

export function isClosedDay(date: string, country: string, subdivision?: string | null, custom: readonly CustomClosure[] = []): boolean {
  if (!isValidIso(date)) throw new Error(`Invalid date "${date}".`);
  const override = custom.find((c) => c.date === date);
  if (override) return override.closed;
  const wd = weekday(date);
  if (wd === 0 || wd === 6) return true;
  return holidaysFor(country, Number(date.slice(0, 4)), subdivision).some((h) => h.date === date && h.kind !== 'observance');
}
export const isBusinessDay = (...a: Parameters<typeof isClosedDay>) => !isClosedDay(...a);

/** Adds `n` (>= 0) business days. Day 0 is `start` itself rolled forward if it is closed. */
export function addBusinessDays(start: string, n: number, country: string, subdivision?: string | null, custom: readonly CustomClosure[] = []): string {
  if (!Number.isInteger(n) || n < 0) throw new Error('n must be a non-negative integer.');
  let d = start;
  while (isClosedDay(d, country, subdivision, custom)) d = addDays(d, 1);
  let left = n;
  while (left > 0) {
    d = addDays(d, 1);
    if (!isClosedDay(d, country, subdivision, custom)) left -= 1;
  }
  return d;
}

export function nextBusinessDay(date: string, country: string, subdivision?: string | null, custom: readonly CustomClosure[] = []): string {
  return addBusinessDays(date, 0, country, subdivision, custom);
}

/** Calendar-month arithmetic that clamps (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return isoDate(ny, nm, Math.min(d, last));
}

import { INDUSTRIES, type Industry } from '@/lib/industries';
import { CLIMATE_LABELS, TRADE_SIGNALS, type ClimateTag } from '@/lib/locationSignals';

export const SITE_URL = 'https://vireek.com';

export interface City {
  slug: string;
  name: string;
  state: string;
  stateCode: string;
  /** Climate patterns that shape call demand here (>= 1). */
  tags: ClimateTag[];
  /** Human-readable peak window, e.g. "May through September". */
  peakSeason: string;
  seasonNote: string;
  housingNote: string;
  /** Real nearby cities/suburbs (>= 5). */
  suburbs: string[];
}

export const CITIES: City[] = [
  {
    slug: 'phoenix', name: 'Phoenix', state: 'Arizona', stateCode: 'AZ',
    tags: ['extreme-heat', 'monsoon'], peakSeason: 'May through September',
    seasonNote: 'Summers here run long and hot, and monsoon storms add sudden spikes on top of the heat.',
    housingNote: 'The metro is mostly sprawling suburban stock with many single-story homes, backyard pools and total reliance on air conditioning.',
    suburbs: ['Scottsdale', 'Tempe', 'Mesa', 'Chandler', 'Glendale', 'Gilbert'],
  },
  {
    slug: 'las-vegas', name: 'Las Vegas', state: 'Nevada', stateCode: 'NV',
    tags: ['extreme-heat', 'monsoon'], peakSeason: 'May through September',
    seasonNote: 'Desert summers are punishing, and short monsoon storms can arrive with little warning.',
    housingNote: 'Rapid growth means a large share of homes are newer tract construction, alongside a big base of condos and short-term rentals.',
    suburbs: ['Henderson', 'North Las Vegas', 'Summerlin', 'Spring Valley', 'Paradise', 'Enterprise'],
  },
  {
    slug: 'houston', name: 'Houston', state: 'Texas', stateCode: 'TX',
    tags: ['humid-heat', 'hurricane'], peakSeason: 'June through November',
    seasonNote: 'Heat and humidity dominate the summer, and hurricane season overlaps the busiest months.',
    housingNote: 'Flat, flood-prone terrain, enormous suburban footprints and many slab-on-grade homes shape what breaks and how fast people call.',
    suburbs: ['Sugar Land', 'Katy', 'The Woodlands', 'Pearland', 'Cypress', 'Pasadena'],
  },
  {
    slug: 'dallas', name: 'Dallas', state: 'Texas', stateCode: 'TX',
    tags: ['humid-heat', 'severe-storm', 'hard-freeze'], peakSeason: 'June through September',
    seasonNote: 'Long hot summers, spring hail and the occasional deep winter freeze each create their own surge.',
    housingNote: 'Fast-growing newer suburbs ring older inner neighborhoods, so equipment age varies enormously from one call to the next.',
    suburbs: ['Plano', 'Irving', 'Frisco', 'Garland', 'Arlington', 'McKinney'],
  },
  {
    slug: 'atlanta', name: 'Atlanta', state: 'Georgia', stateCode: 'GA',
    tags: ['humid-heat', 'severe-storm'], peakSeason: 'May through September',
    seasonNote: 'Humid summers and fast-moving thunderstorms keep the phones busy from late spring onward.',
    housingNote: 'A heavily tree-canopied metro mixes older in-town bungalows with newer suburban builds, so storm damage and aging systems both matter.',
    suburbs: ['Marietta', 'Decatur', 'Roswell', 'Alpharetta', 'Sandy Springs', 'Smyrna'],
  },
  {
    slug: 'miami', name: 'Miami', state: 'Florida', stateCode: 'FL',
    tags: ['humid-heat', 'hurricane'], peakSeason: 'June through November',
    seasonNote: 'Heat and humidity never really leave, and hurricane season drives sharp, short bursts of demand.',
    housingNote: 'Concrete-block homes, many condos and low-lying coastal neighborhoods mean salt air, flooding and building rules shape the work.',
    suburbs: ['Hialeah', 'Coral Gables', 'Miami Beach', 'Doral', 'Homestead', 'Kendall'],
  },
  {
    slug: 'tampa', name: 'Tampa', state: 'Florida', stateCode: 'FL',
    tags: ['humid-heat', 'hurricane', 'severe-storm'], peakSeason: 'June through November',
    seasonNote: 'Daily summer thunderstorms and hurricane season make demand spiky and weather-driven.',
    housingNote: 'The Tampa Bay area spans waterfront neighborhoods, older bungalows and fast-growing suburbs, each with different exposure to storms and flooding.',
    suburbs: ['St. Petersburg', 'Clearwater', 'Brandon', 'Riverview', 'Wesley Chapel', 'Largo'],
  },
  {
    slug: 'charlotte', name: 'Charlotte', state: 'North Carolina', stateCode: 'NC',
    tags: ['humid-heat', 'severe-storm'], peakSeason: 'May through September',
    seasonNote: 'Humid summers and strong spring and summer storms create steady, weather-linked surges.',
    housingNote: 'A booming metro with many newer subdivisions around older close-in neighborhoods keeps both new-install and repair demand high.',
    suburbs: ['Concord', 'Matthews', 'Huntersville', 'Gastonia', 'Mint Hill', 'Cornelius'],
  },
  {
    slug: 'denver', name: 'Denver', state: 'Colorado', stateCode: 'CO',
    tags: ['severe-storm', 'hard-freeze'], peakSeason: 'April through September',
    seasonNote: 'Hail season and sudden cold snaps make demand arrive in sharp, unpredictable waves.',
    housingNote: 'Older brick bungalows in the core and newer foothill and suburban builds mean wide variation in roofs, heating systems and wiring.',
    suburbs: ['Aurora', 'Lakewood', 'Arvada', 'Centennial', 'Littleton', 'Westminster'],
  },
  {
    slug: 'chicago', name: 'Chicago', state: 'Illinois', stateCode: 'IL',
    tags: ['hard-freeze', 'severe-storm', 'humid-heat'], peakSeason: 'November through March',
    seasonNote: 'Brutal winter cold, summer thunderstorms and humid heat waves each bring a distinct rush of calls.',
    housingNote: 'Dense two-flats, greystones, older bungalows and high-rises mean aging plumbing, boilers and wiring are an everyday reality.',
    suburbs: ['Evanston', 'Naperville', 'Oak Park', 'Schaumburg', 'Cicero', 'Skokie'],
  },
  {
    slug: 'minneapolis', name: 'Minneapolis', state: 'Minnesota', stateCode: 'MN',
    tags: ['hard-freeze', 'severe-storm'], peakSeason: 'November through March',
    seasonNote: 'Long, cold winters and violent summer storms create two distinct seasons of urgent calls.',
    housingNote: 'Older housing across the Twin Cities, built for cold, puts heavy demands on heating, insulation, roofing and plumbing.',
    suburbs: ['St. Paul', 'Bloomington', 'Plymouth', 'Edina', 'Maple Grove', 'Brooklyn Park'],
  },
  {
    slug: 'seattle', name: 'Seattle', state: 'Washington', stateCode: 'WA',
    tags: ['wet-mild'], peakSeason: 'October through April',
    seasonNote: 'The rainy season runs for months, so moisture-related calls build steadily instead of arriving in one rush.',
    housingNote: 'Older craftsman homes, hillside lots and dense neighborhoods mean aging lines, crawlspaces and roofs see constant moisture.',
    suburbs: ['Bellevue', 'Tacoma', 'Kirkland', 'Redmond', 'Renton', 'Everett'],
  },
];

export function getCityBySlug(slug: string | undefined): City | undefined {
  return CITIES.find((c) => c.slug === slug);
}

export const locationPath = (city?: City, industry?: Industry): string =>
  !city ? '/locations' : industry ? `/locations/${city.slug}/${industry.slug}` : `/locations/${city.slug}`;

/** Every indexable /locations URL path (hub + city hubs + city x trade pages). */
export function allLocationPaths(): string[] {
  return [
    '/locations',
    ...CITIES.flatMap((c) => [locationPath(c), ...INDUSTRIES.map((i) => locationPath(c, i))]),
  ];
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const joinList = (items: string[]) =>
  items.length <= 2 ? items.join(' and ') : `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;

export interface LocalFaq { q: string; a: string }
export interface LocalDriver { tag: ClimateTag; label: string; text: string }

export interface LocalPage {
  path: string;
  canonical: string;
  title: string;
  description: string;
  h1: string;
  intro: string;
  drivers: LocalDriver[];
  coverage: string[];
  faq: LocalFaq[];
}

/** Deterministic, unique-per-pair content for one trade in one city. */
export function buildLocalPage(industry: Industry, city: City): LocalPage {
  const { name, audience, roi } = industry;
  const signals = TRADE_SIGNALS[industry.slug];
  const drivers: LocalDriver[] = city.tags.map((tag) => ({ tag, label: CLIMATE_LABELS[tag], text: signals[tag] }));
  const lead = drivers[0].text;
  const path = locationPath(city, industry);
  const place = `${city.name}, ${city.stateCode}`;

  return {
    path,
    canonical: `${SITE_URL}${path}`,
    title: `${name} AI Receptionist in ${place} | Vireek`,
    description: `Vireek's AI receptionist answers every call for ${name} companies in ${place}: ${roi.emergencyLabel} triaged, jobs booked 24/7. Start free.`,
    h1: `AI Receptionist for ${name} Companies in ${place}`,
    intro:
      `${name} calls in ${place} follow the weather: ${lowerFirst(lead)} ${city.seasonNote} ` +
      `Vireek's AI receptionist, Sarah, answers every call for ${audience} across ${city.name} and nearby ` +
      `${joinList(city.suburbs.slice(0, 3))}, so ${roi.emergencyLabel} are triaged and booked instead of left on voicemail.`,
    drivers,
    coverage: city.suburbs,
    faq: [
      {
        q: `Can Vireek answer ${roi.emergencyLabel} for ${audience} in ${city.name} after hours?`,
        a: `Yes. Vireek answers every call 24/7, asks trade-specific triage questions, and flags urgent ${roi.emergencyLabel} for immediate dispatch. That matters in ${city.name}, where ${lowerFirst(lead)}`,
      },
      {
        q: `Does Vireek work for ${name} companies serving ${city.suburbs[0]} and ${city.suburbs[1]}?`,
        a: `Yes. Vireek answers calls for your business wherever your customers are and collects each caller's location and job details, so your team can see which part of the ${city.name} area a job is in. Common areas include ${joinList(city.suburbs)}.`,
      },
      {
        q: `How does Vireek handle the ${city.peakSeason} rush in ${city.name}?`,
        a: `Vireek answers unlimited simultaneous calls, so there is no hold queue when volume spikes. ${city.seasonNote} ${city.housingNote}`,
      },
    ],
  };
}

/** schema.org markup for a city x trade page. */
export function buildLocalJsonLd(industry: Industry, city: City, page: LocalPage): Record<string, unknown>[] {
  return [
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE_URL}/` },
        { '@type': 'ListItem', position: 2, name: 'Locations', item: `${SITE_URL}/locations` },
        { '@type': 'ListItem', position: 3, name: city.name, item: `${SITE_URL}${locationPath(city)}` },
        { '@type': 'ListItem', position: 4, name: industry.name, item: page.canonical },
      ],
    },
    {
      '@context': 'https://schema.org',
      '@type': 'Service',
      name: page.h1,
      serviceType: 'AI receptionist and call answering',
      description: page.description,
      url: page.canonical,
      provider: { '@type': 'Organization', name: 'Vireek', url: SITE_URL },
      areaServed: {
        '@type': 'City',
        name: city.name,
        containedInPlace: { '@type': 'State', name: city.state },
      },
      audience: { '@type': 'BusinessAudience', audienceType: industry.audience },
    },
    {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: page.faq.map((f) => ({
        '@type': 'Question',
        name: f.q,
        acceptedAnswer: { '@type': 'Answer', text: f.a },
      })),
    },
  ];
}

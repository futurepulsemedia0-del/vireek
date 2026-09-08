import {
  TrendingUp,
  Wind,
  Droplets,
  Sparkles,
  ClipboardList,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';

export interface BlogCategory {
  slug: string;
  name: string;
  icon: LucideIcon;
}

export const BLOG_CATEGORIES: BlogCategory[] = [
  { slug: 'growth', name: 'Growth & Revenue', icon: TrendingUp },
  { slug: 'hvac', name: 'HVAC', icon: Wind },
  { slug: 'plumbing', name: 'Plumbing', icon: Droplets },
  { slug: 'product', name: 'Product', icon: Sparkles },
  { slug: 'best-practices', name: 'Best Practices', icon: ClipboardList },
  { slug: 'security', name: 'Security', icon: ShieldCheck },
];

export type BlogBlock =
  | { type: 'p'; text: string }
  | { type: 'h2'; text: string }
  | { type: 'list'; items: string[] }
  | { type: 'callout'; text: string };

export interface BlogPost {
  slug: string;
  title: string;
  excerpt: string;
  category: string; // BlogCategory['slug']
  publishedDate: string; // ISO
  readTimeMinutes: number;
  author: string;
  featured?: boolean;
  content: BlogBlock[];
}

export const BLOG_POSTS: BlogPost[] = [
  {
    slug: 'cost-of-a-missed-call',
    title: 'Why Every Missed Call Is a Lost Job (And How to Stop It)',
    excerpt:
      'A missed call rarely means a customer will call back. Here is what actually happens after a home service business misses the phone — and the fixes that work.',
    category: 'growth',
    publishedDate: '2026-08-18',
    readTimeMinutes: 6,
    author: 'The Vireek Team',
    featured: true,
    content: [
      {
        type: 'p',
        text: 'When a home service business misses a call, the usual assumption is that the customer will simply call back later. In practice, that is the exception rather than the rule. Most callers with an urgent need — a broken AC in July, a leaking water heater, a tripped breaker — move straight to the next number on the search results page. The call was never really "missed." It was handed to a competitor.',
      },
      {
        type: 'h2',
        text: 'The math is worse than it feels',
      },
      {
        type: 'p',
        text: 'A single missed job might feel like a rounding error in a busy week. But multiply a handful of missed calls a week by an average ticket size, and by the end of a quarter the number is usually large enough to fund a full-time hire. The businesses that track this number closely tend to be the ones most motivated to fix it, because it stops being abstract and starts showing up in the P&L.',
      },
      {
        type: 'list',
        items: [
          'After-hours calls: the highest-intent, most time-sensitive calls of the day, and the ones most likely to go unanswered.',
          'Calls during active jobs: your team is on a roof or under a sink, not near a phone.',
          'Calls during peak season: exactly when call volume spikes past what a small office team can absorb.',
        ],
      },
      {
        type: 'h2',
        text: 'Voicemail does not solve this',
      },
      {
        type: 'p',
        text: 'Voicemail was built for a world where people expected to wait for a callback. That expectation has largely disappeared. A caller who hits voicemail today assumes the business is unavailable or uninterested, and moves on within seconds. Adding more voicemail greetings, longer hold messages, or a callback promise does not change the caller\u2019s behavior — it just delays the moment they hang up.',
      },
      {
        type: 'h2',
        text: 'What actually closes the gap',
      },
      {
        type: 'p',
        text: 'The businesses that stop losing jobs to missed calls generally do one of two things: hire enough staff to guarantee live coverage around the clock, or put a system in place that behaves like a live person without the staffing cost. For most home service businesses, 24/7 staffing is not realistic. That is the specific gap an AI voice receptionist like Sarah is built to close — answering every call immediately, asking the right qualifying questions for your trade, and getting the details your team needs to follow up fast.',
      },
      {
        type: 'callout',
        text: 'If you want to see exactly what missed calls are costing your business today, the Revenue Calculator gives you a number based on your own call volume and average ticket size.',
      },
    ],
  },
  {
    slug: 'ai-receptionist-cost',
    title: 'How Much Does an AI Receptionist Cost?',
    excerpt:
      'A breakdown of what you actually pay for an AI receptionist versus a full-time hire or a traditional answering service \u2014 and the missed-call cost that makes the comparison worth doing.',
    category: 'growth',
    publishedDate: '2026-09-07',
    readTimeMinutes: 6,
    author: 'The Vireek Team',
    content: [
      {
        type: 'p',
        text: 'Before comparing prices, it helps to be clear about what you\u2019re actually pricing. Answering the phone for a home service business can be handled three ways: hiring someone in-house, paying a traditional answering service, or using an AI receptionist. Each has a very different cost structure, and the sticker price on any one of them only tells part of the story.',
      },
      {
        type: 'h2',
        text: 'What a full-time receptionist costs',
      },
      {
        type: 'p',
        text: 'Industry salary data puts the average U.S. receptionist wage at roughly $17\u2013$18 an hour, which works out to a base salary in the $35,000\u2013$45,000 range once you annualize it \u2014 before payroll taxes, benefits, or paid time off. That pays for one person covering standard business hours. It does not cover nights, weekends, lunch breaks, sick days, or the after-hours emergency call that home service businesses tend to lose the most money on.',
      },
      {
        type: 'h2',
        text: 'What a traditional answering service costs',
      },
      {
        type: 'p',
        text: 'Live answering services generally charge $50\u2013$500+ a month depending on call volume and coverage hours, with per-minute overage rates commonly landing between $0.75 and $3.00 a minute once you exceed your plan. That cost scales in a straight line with how many calls you get \u2014 a slow month is cheap, but a busy season or a marketing push can push the bill up quickly, right when you need coverage the most.',
      },
      {
        type: 'h2',
        text: 'What an AI receptionist costs',
      },
      {
        type: 'p',
        text: 'Vireek\u2019s published plans are a useful reference point here because the pricing is public rather than quoted case by case: a Free tier with 50 minutes to try it, Starter at $79/month for 400 minutes, Professional at $199/month for 1,500 minutes (the plan most solo and small-crew contractors land on), Business at $399/month for 4,000 minutes across up to 3 locations, and custom Enterprise pricing starting around $999/month for unlimited minutes and locations. Every plan answers every call, 24/7 \u2014 the coverage gap that costs the most with a single in-house hire or a capped answering-service plan simply doesn\u2019t exist.',
      },
      {
        type: 'list',
        items: [
          'Free \u2014 $0/month, 50 minutes, 1 seat, 1 location. For proving the value before spending anything.',
          'Starter \u2014 $79/month, 400 minutes, 2 seats. Smart booking, SMS confirmations, 1 CRM integration.',
          'Professional \u2014 $199/month, 1,500 minutes, 5 seats. Emergency detection, live dispatch, full CRM sync.',
          'Business \u2014 $399/month, 4,000 minutes, up to 3 locations. Custom voice and script per location.',
          'Enterprise \u2014 from $999/month, unlimited minutes and locations. Custom-trained voice, dedicated account manager.',
        ],
      },
      {
        type: 'h2',
        text: 'The number that actually decides the comparison',
      },
      {
        type: 'p',
        text: 'None of the three options above is "expensive" or "cheap" in isolation \u2014 what makes the comparison worth running is what a missed call costs your specific business. A single missed emergency job in home services is commonly worth well over $1,000, and a contractor who misses even a handful of calls a week is very likely losing more in unbooked jobs than any of these options would cost to run every month.',
      },
      {
        type: 'callout',
        text: 'If you want to see this comparison run against your own numbers instead of industry averages, the Revenue Calculator estimates what missed calls are costing your business based on your actual call volume and average ticket size \u2014 and the Free plan lets you test real call handling before you commit to a paid tier.',
      },
    ],
  },
  {
    slug: 'hvac-emergency-call-triage',
    title: 'HVAC Emergency Calls: How to Triage Without a Live Dispatcher',
    excerpt:
      'No-heat and no-cool calls do not wait for business hours. Here is how HVAC companies can triage urgency without keeping someone glued to the phone.',
    category: 'hvac',
    publishedDate: '2026-08-25',
    readTimeMinutes: 5,
    author: 'The Vireek Team',
    content: [
      {
        type: 'p',
        text: 'No-heat calls in January and no-cool calls in July share the same problem: they spike exactly when your team is already stretched thin, and they spike outside the hours your office is staffed. A homeowner without air conditioning during a heat wave is not going to wait until 8am to leave a message. They are calling the first HVAC company that answers.',
      },
      {
        type: 'h2',
        text: 'Not every "emergency" call is actually urgent',
      },
      {
        type: 'p',
        text: 'Part of what makes phone triage hard is that callers are not always accurate judges of their own urgency. A thermostat display glitch and a cracked heat exchanger can sound identical over the phone if the caller does not know what to describe. Good triage depends on asking the right structured questions — system type, symptoms, how long the issue has been happening, whether there is a safety concern like a gas smell — rather than relying on the caller\u2019s own framing of "emergency."',
      },
      {
        type: 'list',
        items: [
          'System type and age — narrows down likely causes before a technician even arrives.',
          'When the issue started and whether it is intermittent or constant.',
          'Any safety-relevant symptoms — burning smell, gas smell, visible sparking, water pooling near equipment.',
          'Whether vulnerable occupants (infants, elderly, medical equipment) are in the home, which can change dispatch priority.',
        ],
      },
      {
        type: 'h2',
        text: 'Consistent triage beats heroic effort',
      },
      {
        type: 'p',
        text: 'Dispatchers who are good at this do it the same way every time — the same handful of questions, asked in the same order, regardless of how the call started. That consistency is what makes triage reliable at 2am as much as at 2pm. It is also exactly the kind of structured, repeatable process that an AI receptionist can carry out on every single call, without fatigue and without skipping a step because it is the fortieth call of the day.',
      },
      {
        type: 'p',
        text: 'With Sarah configured for your business, every no-heat or no-cool call gets the same triage questions, the true emergencies get flagged for immediate dispatch, and the calls that turn out to be simple filter or thermostat questions get handled without pulling a technician off a job.',
      },
    ],
  },
  {
    slug: 'ai-receptionist-vs-answering-service',
    title: 'AI Receptionist vs. Traditional Answering Service: What\u2019s the Real Difference?',
    excerpt:
      'Both promise to answer your calls. The difference shows up in consistency, cost at scale, and what happens to the information after the call ends.',
    category: 'product',
    publishedDate: '2026-09-01',
    readTimeMinutes: 7,
    author: 'The Vireek Team',
    content: [
      {
        type: 'p',
        text: 'Traditional answering services and AI voice receptionists solve the same surface problem — someone (or something) picks up the phone when your team can\u2019t. Past that surface, the two look quite different in how they behave, what they cost as call volume grows, and what happens to the information after the call ends.',
      },
      {
        type: 'h2',
        text: 'Consistency across every call',
      },
      {
        type: 'p',
        text: 'A traditional answering service typically routes calls across a pool of agents who may not be dedicated to your business full-time. Script adherence, tone, and the depth of qualifying questions can vary from agent to agent and shift to shift. An AI receptionist configured for your business asks the same qualifying questions, in the same way, on every single call — the hundredth call of the week gets the same attention as the first.',
      },
      {
        type: 'h2',
        text: 'Cost that does not scale linearly with volume',
      },
      {
        type: 'p',
        text: 'Traditional answering services generally charge per minute or per call handled by a human agent, which means costs climb in a straight line with call volume. AI-based call handling has a different cost structure — able to absorb call spikes (a heat wave, a storm, a marketing campaign) without needing to staff up in advance.',
      },
      {
        type: 'h2',
        text: 'What happens after the call matters as much as the call itself',
      },
      {
        type: 'p',
        text: 'A message taken by a human answering service usually arrives as a note — a name, a number, a brief description. An AI receptionist built specifically for structured lead capture can turn a call directly into a structured record: qualified lead details, a booked appointment on your calendar, or a flagged emergency ready for dispatch, without someone re-typing a paper note into your system.',
      },
      {
        type: 'list',
        items: [
          'Traditional answering service: variable script quality, per-minute cost that scales with volume, output is usually a message.',
          'AI receptionist (Sarah): consistent trade-specific qualifying questions on every call, cost that does not scale linearly with call spikes, output is a structured lead, booking, or emergency flag.',
        ],
      },
      {
        type: 'callout',
        text: 'Neither option replaces human judgment for genuinely complex situations — the right choice depends on your call volume, your trade, and how much structure you need from every call.',
      },
    ],
  },
  {
    slug: 'plumbing-missed-call-cost',
    title: 'How Much Is a Missed Call Actually Costing Your Plumbing Business?',
    excerpt:
      'Plumbing calls are disproportionately urgent — burst pipes and backed-up drains do not wait. Here is how to put a real number on what missed calls cost.',
    category: 'plumbing',
    publishedDate: '2026-08-29',
    readTimeMinutes: 5,
    author: 'The Vireek Team',
    content: [
      {
        type: 'p',
        text: 'Plumbing calls skew more urgent than almost any other home service trade. A burst pipe, a backed-up main line, or a water heater that has started leaking onto a finished floor does not wait for business hours, and it does not wait for a callback. The homeowner on the other end of that call is actively watching a problem get worse in real time.',
      },
      {
        type: 'h2',
        text: 'Put a number on it',
      },
      {
        type: 'p',
        text: 'To estimate what missed calls are really costing, three inputs matter: how many calls go unanswered in an average week, what share of those callers would have become paying jobs, and your average ticket size. Multiply those together and extend it across a year, and most plumbing businesses find the number is larger than expected — often large enough to justify the exact kind of always-on call coverage that used to only be affordable for large multi-location operators.',
      },
      {
        type: 'list',
        items: [
          'Unanswered calls per week (check your phone system\u2019s missed-call log if you have one).',
          'Estimated close rate on inbound calls you do answer.',
          'Average ticket size across your typical service mix.',
        ],
      },
      {
        type: 'h2',
        text: 'Emergency calls carry outsized weight',
      },
      {
        type: 'p',
        text: 'Not all missed calls are equal. A missed call about scheduling a routine drain cleaning is a lost job. A missed call about an active pipe burst is a lost job today and a lost customer relationship going forward, since that homeowner will remember who did — or didn\u2019t — pick up when it mattered. Weighing emergency calls more heavily in your estimate gives a more honest picture of what is at stake.',
      },
      {
        type: 'p',
        text: 'This is exactly the calculation behind Vireek\u2019s Revenue Calculator — plug in your own numbers and see the estimate for your specific business rather than an industry average.',
      },
    ],
  },
  {
    slug: 'perfect-call-script-home-services',
    title: 'The Anatomy of a Perfect Call Script for Home Service Businesses',
    excerpt:
      'Great phone scripts are not about sounding scripted — they are about asking the right questions in the right order, every single time.',
    category: 'best-practices',
    publishedDate: '2026-09-03',
    readTimeMinutes: 6,
    author: 'The Vireek Team',
    content: [
      {
        type: 'p',
        text: 'The word "script" makes a lot of business owners nervous, because a script that sounds robotic can actively drive callers away. But a good call script was never about reciting fixed sentences — it is about making sure a small set of essential questions get asked, in a sensible order, on every call, regardless of who or what is answering the phone.',
      },
      {
        type: 'h2',
        text: 'Start with a real greeting, not a menu',
      },
      {
        type: 'p',
        text: 'The first five seconds set the tone for the entire call. A greeting that names the business and offers real help ("Ramirez Plumbing, this is Sarah — how can I help?") signals a live, capable conversation. A phone tree with six options signals exactly the opposite, and is often where impatient callers hang up.',
      },
      {
        type: 'h2',
        text: 'The core qualifying questions',
      },
      {
        type: 'list',
        items: [
          'What service does the caller need? (Get specific — "AC repair" versus "no cool" versus "strange noise" all lead to different next steps.)',
          'Where is the property located? (Confirms it is inside your service area before anything else happens.)',
          'How urgent is it, and is there a safety concern?',
          'What is the best way and time to reach them back?',
        ],
      },
      {
        type: 'h2',
        text: 'Know when to stop qualifying and start booking',
      },
      {
        type: 'p',
        text: 'A common mistake is over-qualifying a caller who is clearly ready to book, which frustrates them and risks losing the job to a competitor who moves faster. The best scripts recognize a ready-to-book caller early and move straight to scheduling, while still capturing enough detail for the technician to arrive prepared.',
      },
      {
        type: 'h2',
        text: 'Build it once, apply it every time',
      },
      {
        type: 'p',
        text: 'The hardest part of a good call script is not writing it — it is applying it consistently across every single call, at every hour, regardless of how busy the day has been. That consistency is exactly what Sarah is built to deliver: your qualifying questions, your service area rules, your escalation preferences, applied the same way on call one and call one hundred.',
      },
    ],
  },
  {
    slug: 'ai-vendor-security-checklist',
    title: 'Data Security for Home Service Businesses: What to Ask Any AI Vendor',
    excerpt:
      'Your customers trust you with their address, their schedule, and sometimes access to their home. Here is what to ask before handing call data to any AI vendor.',
    category: 'security',
    publishedDate: '2026-09-05',
    readTimeMinutes: 6,
    author: 'The Vireek Team',
    content: [
      {
        type: 'p',
        text: 'Home service businesses collect more sensitive information than most people realize: home addresses, gate codes, schedules that reveal when a house is empty, and sometimes payment details. Before handing any of that to a third-party AI vendor to answer your calls, it is worth asking a few direct questions.',
      },
      {
        type: 'h2',
        text: 'Where does the data actually live?',
      },
      {
        type: 'p',
        text: 'Ask whether caller data is encrypted both in transit and at rest, and whether it is stored in a way that is logically isolated per business — meaning one company\u2019s data cannot be queried alongside another\u2019s by mistake. Vireek enforces this with database-level Row Level Security policies scoped to each account, not just application-level checks that could be bypassed by a bug.',
      },
      {
        type: 'h2',
        text: 'Who on your own team can see what?',
      },
      {
        type: 'p',
        text: 'Not every team member needs the same visibility. A technician generally only needs to see the jobs assigned to them; an office manager may need the full call and lead history. Ask whether the vendor supports role-based permissions, and whether sensitive account actions — like changing someone\u2019s permissions or deleting a job — are recorded somewhere you can review later.',
      },
      {
        type: 'list',
        items: [
          'Is data encrypted in transit and at rest?',
          'Is my business\u2019s data logically isolated from every other customer\u2019s data?',
          'Can I set different access levels for different team members?',
          'Is there an audit trail for sensitive account changes?',
          'What happens to call recordings and transcripts, and for how long are they kept?',
        ],
      },
      {
        type: 'h2',
        text: 'Ask for specifics, not reassurance',
      },
      {
        type: 'p',
        text: '"We take security seriously" is not an answer — it is a sentence every vendor says. A vendor that can describe specifically how access is restricted, how changes are logged, and how long data is retained is one that has actually built these protections rather than simply claiming them. Vireek\u2019s full security practices, including the audit log and account-level access controls, are documented on the Security page.',
      },
    ],
  },
];

export function getPostBySlug(slug: string): BlogPost | undefined {
  return BLOG_POSTS.find((post) => post.slug === slug);
}

export function getCategoryBySlug(slug: string): BlogCategory | undefined {
  return BLOG_CATEGORIES.find((category) => category.slug === slug);
}

export function getRelatedPosts(post: BlogPost, count = 2): BlogPost[] {
  const sameCategory = BLOG_POSTS.filter((p) => p.slug !== post.slug && p.category === post.category);
  const others = BLOG_POSTS.filter((p) => p.slug !== post.slug && p.category !== post.category);
  return [...sameCategory, ...others].slice(0, count);
}

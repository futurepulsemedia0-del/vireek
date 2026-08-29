import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowRight, CheckCircle2, ChevronDown, LockKeyhole, PhoneCall, ShieldCheck, Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { CookieConsent } from '@/components/CookieConsent';
import { EASE, viewport } from '@/lib/motion';

const FAQ_CATEGORIES = [
  {
    name: 'General Questions',
    description: 'Start here for the essentials about Vireek and AI voice reception.',
    questions: [
      {
        q: 'What is Vireek?',
        a: 'Vireek is an AI voice receptionist platform that answers business calls, captures caller details, qualifies leads, and keeps customer communication moving 24/7. It helps teams respond faster without forcing every call into voicemail or manual follow-up.',
      },
      {
        q: 'Is Vireek a real person?',
        a: 'No. Vireek is AI software designed to sound natural, understand caller intent, and collect the information your team needs. Callers get a responsive voice experience while your business keeps a reliable record of each conversation.',
      },
      {
        q: 'How does Vireek work?',
        a: 'Your business routes calls to Vireek, the AI receptionist answers with your preferred greeting, asks relevant questions, captures important details, and helps route or summarize the conversation so your team can take the right next step.',
      },
    ],
  },
  {
    name: 'Features & Capabilities',
    description: 'Understand what Vireek can do for high-intent inbound calls.',
    questions: [
      {
        q: 'Can Vireek answer calls 24/7?',
        a: 'Yes. Vireek can answer calls around the clock, including after hours, weekends, and holidays, so customers can reach your business even when your team is busy or unavailable.',
      },
      {
        q: 'Can Vireek handle emergency calls?',
        a: 'Vireek can identify urgent language, collect key details, and flag time-sensitive calls for faster follow-up. It is not a replacement for emergency services, but it can help your business avoid missing critical customer requests.',
      },
      {
        q: 'Does Vireek understand natural conversations?',
        a: 'Yes. Vireek is designed for conversational interactions, including follow-up questions, caller context, and common business scenarios. The experience feels more natural than a rigid phone tree or voicemail prompt.',
      },
      {
        q: 'Can I customize Vireek responses?',
        a: 'Yes. You can align Vireek with your business details, service areas, preferred tone, qualifying questions, and escalation preferences so callers receive answers that match your operation.',
      },
    ],
  },
  {
    name: 'Business Use Cases',
    description: 'See how teams use Vireek to protect revenue and improve responsiveness.',
    questions: [
      {
        q: 'What types of businesses can use Vireek?',
        a: 'Vireek is useful for service businesses, local operators, appointment-based teams, and growth-focused companies that receive valuable phone inquiries and need consistent customer communication.',
      },
      {
        q: 'Can Vireek replace my receptionist?',
        a: 'Vireek can handle many front-desk call answering and intake tasks, especially after hours or during peak volume. Many teams use it to support their receptionist rather than fully replace human judgment for complex situations.',
      },
      {
        q: 'How does Vireek help businesses grow?',
        a: 'Vireek helps reduce missed calls, capture more leads, respond outside business hours, and create cleaner call records. That means fewer lost opportunities and faster follow-up for prospects who are ready to buy.',
      },
    ],
  },
  {
    name: 'Setup & Integration',
    description: 'Get clarity on launch time, phone numbers, and existing workflows.',
    questions: [
      {
        q: 'Do I need to change my phone number?',
        a: 'No. In most cases, you can keep your existing business number and forward calls to Vireek. Your customers continue using the phone number they already know.',
      },
      {
        q: 'How long does setup take?',
        a: 'Setup is designed to be fast. You provide your business information, configure call handling preferences, and connect your phone flow so Vireek can begin answering calls quickly.',
      },
      {
        q: 'Does Vireek integrate with existing tools?',
        a: 'Vireek is built to fit into existing business workflows by capturing structured call information and making follow-up easier. Integration options depend on your current tools and operational needs.',
      },
    ],
  },
  {
    name: 'Pricing & Security',
    description: 'Review commercial fit, trials, and data protection expectations.',
    questions: [
      {
        q: 'How much does Vireek cost?',
        a: 'Vireek offers straightforward SaaS pricing based on the plan and usage that fits your business. Visit the pricing section or start a trial to compare options for your call volume and growth goals.',
      },
      {
        q: 'Is customer data secure?',
        a: 'Vireek is designed with business-grade data protection practices, controlled access, and careful handling of caller information. Customer trust is central to the product experience.',
      },
      {
        q: 'Can I try Vireek before committing?',
        a: 'Yes. You can start with a trial experience to evaluate how Vireek answers calls, captures information, and supports your team before choosing the plan that is right for your business.',
      },
    ],
  },
] as const;

const faqSchema = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: FAQ_CATEGORIES.flatMap((category) =>
    category.questions.map((faq) => ({
      '@type': 'Question',
      name: faq.q,
      acceptedAnswer: {
        '@type': 'Answer',
        text: faq.a,
      },
    }))
  ),
};

function SEO() {
  useEffect(() => {
    const title = 'Frequently Asked Questions | Vireek AI Voice Receptionist';
    const description = "Everything you need to know about Vireek's AI voice receptionist for 24/7 call answering, lead capture, setup, pricing, and security.";
    const previousTitle = document.title;
    const upsertMeta = (name: string, content: string) => {
      let meta = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
      if (!meta) {
        meta = document.createElement('meta');
        meta.setAttribute('name', name);
        document.head.appendChild(meta);
      }
      const previous = meta.getAttribute('content');
      meta.setAttribute('content', content);
      return () => {
        if (previous === null) meta?.remove();
        else meta?.setAttribute('content', previous);
      };
    };

    document.title = title;
    const cleanupDescription = upsertMeta('description', description);
    const cleanupRobots = upsertMeta('robots', 'index, follow');
    const script = document.createElement('script');
    script.type = 'application/ld+json';
    script.text = JSON.stringify(faqSchema);
    document.head.appendChild(script);

    return () => {
      document.title = previousTitle;
      cleanupDescription();
      cleanupRobots();
      script.remove();
    };
  }, []);

  return null;
}

function FAQItem({ question, answer, id, isOpen, onToggle }: { question: string; answer: string; id: string; isOpen: boolean; onToggle: () => void }) {
  const panelId = `${id}-panel`;
  const buttonId = `${id}-button`;

  return (
    <div className="rounded-2xl border border-border bg-bg-secondary/90 shadow-card transition-colors dark:shadow-card-dark">
      <h3>
        <button
          id={buttonId}
          type="button"
          aria-expanded={isOpen}
          aria-controls={panelId}
          onClick={onToggle}
          className="focus-ring flex w-full items-center justify-between gap-5 rounded-2xl px-5 py-5 text-left sm:px-6"
        >
          <span className="text-base font-semibold leading-7 text-text-primary sm:text-lg">{question}</span>
          <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border transition-colors ${isOpen ? 'border-accent/30 bg-accent/10 text-accent' : 'border-border bg-bg-tertiary text-text-secondary'}`}>
            <ChevronDown className={`h-5 w-5 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
          </span>
        </button>
      </h3>
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            id={panelId}
            role="region"
            aria-labelledby={buttonId}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.24, ease: EASE }}
            className="overflow-hidden"
          >
            <p className="px-5 pb-6 text-base leading-8 text-text-secondary sm:px-6">{answer}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function FAQPage() {
  const firstItem = useMemo(() => `${FAQ_CATEGORIES[0].name}-0`.replace(/\s+/g, '-').toLowerCase(), []);
  const [openItem, setOpenItem] = useState<string | null>(firstItem);

  return (
    <>
      <SEO />
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary pt-24">
        <section className="relative bg-gradient-mesh bg-noise px-6 py-20 sm:py-24 lg:py-28">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />
          <div className="mx-auto max-w-5xl text-center">
            <motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55, ease: EASE }}>
              <div className="mx-auto mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-bg-secondary/80 px-4 py-2 text-sm font-semibold text-text-secondary shadow-sm backdrop-blur">
                <Sparkles className="h-4 w-4 text-accent" />
                Enterprise-ready call intelligence
              </div>
              <h1 className="text-balance text-5xl font-extrabold tracking-tight text-text-primary sm:text-6xl lg:text-7xl">Frequently Asked Questions</h1>
              <p className="mx-auto mt-6 max-w-3xl text-xl leading-8 text-text-secondary sm:text-2xl">
                Everything you need to know about Vireek&apos;s AI voice receptionist.
              </p>
              <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
                <Link to="/login"><Button variant="primary" size="lg">Start Free Trial</Button></Link>
                <a href="/#pricing" className="focus-ring inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-text-primary transition-colors hover:text-accent">View pricing <ArrowRight className="h-4 w-4" /></a>
              </div>
            </motion.div>
          </div>
        </section>

        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto grid max-w-7xl gap-12 lg:grid-cols-[0.85fr_1.5fr]">
            <aside className="lg:sticky lg:top-28 lg:self-start">
              <div className="rounded-3xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
                <p className="text-sm font-semibold uppercase tracking-[0.2em] text-accent">Support</p>
                <h2 className="mt-3 text-3xl font-bold tracking-tight text-text-primary">Answers that reduce risk before you launch.</h2>
                <p className="mt-4 text-base leading-7 text-text-secondary">Use this guide to evaluate call coverage, customization, setup, security, and the business case for an AI receptionist.</p>
                <div className="mt-6 grid gap-3 text-sm font-medium text-text-secondary">
                  {['24/7 answering', 'Lead capture', 'Secure workflows'].map((item) => (
                    <div key={item} className="flex items-center gap-3"><CheckCircle2 className="h-5 w-5 text-success" />{item}</div>
                  ))}
                </div>
              </div>
            </aside>

            <div className="space-y-10">
              {FAQ_CATEGORIES.map((category, categoryIndex) => (
                <motion.section key={category.name} initial={{ opacity: 0, y: 18 }} whileInView={{ opacity: 1, y: 0 }} viewport={viewport} transition={{ duration: 0.45, ease: EASE, delay: Math.min(categoryIndex * 0.06, 0.24) }} className="scroll-mt-28">
                  <div className="mb-5 flex items-start gap-4">
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-accent/20 bg-accent/10 text-accent">
                      {categoryIndex % 3 === 0 ? <PhoneCall className="h-5 w-5" /> : categoryIndex % 3 === 1 ? <ShieldCheck className="h-5 w-5" /> : <LockKeyhole className="h-5 w-5" />}
                    </div>
                    <div>
                      <h2 className="text-2xl font-bold tracking-tight text-text-primary">{category.name}</h2>
                      <p className="mt-1 text-base leading-7 text-text-secondary">{category.description}</p>
                    </div>
                  </div>
                  <div className="space-y-4">
                    {category.questions.map((faq, questionIndex) => {
                      const id = `${category.name}-${questionIndex}`.replace(/\s+/g, '-').toLowerCase();
                      return <FAQItem key={faq.q} id={id} question={faq.q} answer={faq.a} isOpen={openItem === id} onToggle={() => setOpenItem(openItem === id ? null : id)} />;
                    })}
                  </div>
                </motion.section>
              ))}
            </div>
          </div>
        </section>

        <section className="px-6 pb-24">
          <div className="mx-auto max-w-5xl rounded-[2rem] border border-border bg-bg-secondary p-8 text-center shadow-card dark:shadow-card-dark sm:p-12">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-accent">Ready when your customers call</p>
            <h2 className="mt-4 text-3xl font-bold tracking-tight text-text-primary sm:text-4xl">Turn missed calls into captured opportunities.</h2>
            <p className="mx-auto mt-4 max-w-2xl text-base leading-7 text-text-secondary">Launch Vireek to answer calls, qualify demand, and help your team follow up with confidence.</p>
            <div className="mt-8"><Link to="/login"><Button variant="primary" size="lg">Start Free Trial</Button></Link></div>
          </div>
        </section>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}

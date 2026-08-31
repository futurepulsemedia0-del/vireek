diff -ruN '--exclude=vite.config.ts.timestamp*' a/index.html b/index.html
--- a/index.html	2026-08-30 17:34:42.000000000 +0000
+++ b/index.html	2026-08-30 19:02:49.830359494 +0000
@@ -3,7 +3,56 @@
   <head>
     <meta charset="UTF-8" />
     <meta name="viewport" content="width=device-width, initial-scale=1.0" />
-    <title>Vireek Dashboard</title>
+
+    <!-- Primary SEO -->
+    <title>Vireek — AI Receptionist for Home Service Businesses</title>
+    <meta name="description" content="Vireek is the AI receptionist built for plumbers, HVAC, electricians, and home service pros. Never miss another call: instant answering, appointment booking, lead capture, and CRM sync — 24/7." />
+    <meta name="keywords" content="AI receptionist, missed call, home service business, appointment booking software, AI answering service, plumber software, HVAC software, electrician CRM" />
+    <link rel="canonical" href="https://vireek.com/" />
+    <meta name="robots" content="index, follow" />
+    <meta name="author" content="Vireek" />
+
+    <!-- Favicon -->
+    <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
+    <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />
+    <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
+    <meta name="theme-color" content="#4F46E5" />
+
+    <!-- Open Graph (Facebook, LinkedIn, WhatsApp, iMessage...) -->
+    <meta property="og:type" content="website" />
+    <meta property="og:site_name" content="Vireek" />
+    <meta property="og:url" content="https://vireek.com/" />
+    <meta property="og:title" content="Vireek — AI Receptionist for Home Service Businesses" />
+    <meta property="og:description" content="Never miss another call. Vireek answers, books appointments, and captures leads for your home service business, 24/7." />
+    <meta property="og:image" content="https://vireek.com/og-image.png" />
+    <meta property="og:image:width" content="1200" />
+    <meta property="og:image:height" content="630" />
+    <meta property="og:locale" content="en_US" />
+
+    <!-- Twitter Card -->
+    <meta name="twitter:card" content="summary_large_image" />
+    <meta name="twitter:title" content="Vireek — AI Receptionist for Home Service Businesses" />
+    <meta name="twitter:description" content="Never miss another call. Vireek answers, books appointments, and captures leads for your home service business, 24/7." />
+    <meta name="twitter:image" content="https://vireek.com/og-image.png" />
+
+    <!-- Structured Data (Google rich results) -->
+    <script type="application/ld+json">
+    {
+      "@context": "https://schema.org",
+      "@type": "SoftwareApplication",
+      "name": "Vireek",
+      "applicationCategory": "BusinessApplication",
+      "operatingSystem": "Web",
+      "url": "https://vireek.com/",
+      "description": "AI receptionist for home service businesses. Instant call answering, appointment booking, lead capture, and CRM sync — 24/7.",
+      "offers": {
+        "@type": "Offer",
+        "price": "0",
+        "priceCurrency": "USD",
+        "description": "Free plan available"
+      }
+    }
+    </script>
   </head>
   <body>
     <div id="root"></div>
diff -ruN '--exclude=vite.config.ts.timestamp*' a/public/sitemap.xml b/public/sitemap.xml
--- a/public/sitemap.xml	2026-08-30 17:34:42.000000000 +0000
+++ b/public/sitemap.xml	2026-08-31 04:36:51.518769560 +0000
@@ -13,6 +13,36 @@
     <priority>0.7</priority>
   </url>
   <url>
+    <loc>https://vireek.com/industries/hvac</loc>
+    <lastmod>2026-08-31</lastmod>
+    <changefreq>monthly</changefreq>
+    <priority>0.8</priority>
+  </url>
+  <url>
+    <loc>https://vireek.com/industries/plumbing</loc>
+    <lastmod>2026-08-31</lastmod>
+    <changefreq>monthly</changefreq>
+    <priority>0.8</priority>
+  </url>
+  <url>
+    <loc>https://vireek.com/industries/roofing</loc>
+    <lastmod>2026-08-31</lastmod>
+    <changefreq>monthly</changefreq>
+    <priority>0.8</priority>
+  </url>
+  <url>
+    <loc>https://vireek.com/industries/electrical</loc>
+    <lastmod>2026-08-31</lastmod>
+    <changefreq>monthly</changefreq>
+    <priority>0.8</priority>
+  </url>
+  <url>
+    <loc>https://vireek.com/industries/restoration</loc>
+    <lastmod>2026-08-31</lastmod>
+    <changefreq>monthly</changefreq>
+    <priority>0.8</priority>
+  </url>
+  <url>
     <loc>https://vireek.com/privacy</loc>
     <lastmod>2026-08-20</lastmod>
     <changefreq>monthly</changefreq>
diff -ruN '--exclude=vite.config.ts.timestamp*' a/src/App.tsx b/src/App.tsx
--- a/src/App.tsx	2026-08-30 17:34:42.000000000 +0000
+++ b/src/App.tsx	2026-08-31 04:36:31.398631196 +0000
@@ -17,6 +17,7 @@
 import { PrivacyPage } from '@/pages/PrivacyPage';
 import { TermsPage } from '@/pages/TermsPage';
 import { FAQPage } from '@/pages/FAQPage';
+import { IndustryPage } from '@/pages/IndustryPage';
 import { ProtectedRoute } from '@/components/ProtectedRoute';
 
 function App() {
@@ -29,6 +30,7 @@
       <Route path="/privacy" element={<PrivacyPage />} />
       <Route path="/terms" element={<TermsPage />} />
       <Route path="/faq" element={<FAQPage />} />
+      <Route path="/industries/:slug" element={<IndustryPage />} />
       <Route path="/pricing" element={<PricingPage />} />
       <Route
         path="/dashboard"
diff -ruN '--exclude=vite.config.ts.timestamp*' a/src/components/DashboardNav.tsx b/src/components/DashboardNav.tsx
--- a/src/components/DashboardNav.tsx	2026-08-30 17:34:42.000000000 +0000
+++ b/src/components/DashboardNav.tsx	2026-08-30 18:51:57.874534891 +0000
@@ -5,6 +5,7 @@
 import { useAuth } from '@/contexts/AuthContext';
 import { useToast } from '@/contexts/ToastContext';
 import { ThemeToggle } from '@/components/ThemeToggle';
+import { UpgradeBanner } from '@/components/UpgradeBanner';
 
 interface NavItem {
   label: string;
@@ -194,7 +195,10 @@
     <div className="min-h-screen bg-bg-primary">
       <DashboardNav activeLabel={activeLabel} />
       <div className="lg:pl-60">
-        <main className="mx-auto max-w-7xl px-4 py-6 lg:px-8 lg:py-8">{children}</main>
+        <main className="mx-auto max-w-7xl px-4 py-6 lg:px-8 lg:py-8">
+          <UpgradeBanner />
+          {children}
+        </main>
       </div>
     </div>
   );
diff -ruN '--exclude=vite.config.ts.timestamp*' a/src/components/UpgradeBanner.tsx b/src/components/UpgradeBanner.tsx
--- a/src/components/UpgradeBanner.tsx	1970-01-01 00:00:00.000000000 +0000
+++ b/src/components/UpgradeBanner.tsx	2026-08-30 19:20:55.787589438 +0000
@@ -0,0 +1,207 @@
+import { useCallback, useEffect, useState } from 'react';
+import { AnimatePresence, motion } from 'framer-motion';
+import { useNavigate } from 'react-router-dom';
+import {
+  Rocket,
+  Sparkles,
+  X,
+  Phone,
+  CalendarClock,
+  RefreshCw,
+  ShieldAlert,
+  Zap,
+  ArrowRight,
+  Loader as Loader2,
+} from 'lucide-react';
+import { useAuth } from '@/contexts/AuthContext';
+
+// ============================================================
+// CONFIG
+// ============================================================
+
+/**
+ * localStorage key prefix used to persist the "dismissed" choice on this
+ * device. Suffixed with the user's id so dismissing the banner on one
+ * account never hides it for a different account signing in on the same
+ * browser (e.g. testing with email, then with Google).
+ */
+const DISMISS_STORAGE_PREFIX = 'vireek-upgrade-banner-dismissed-v1';
+
+/** Where the primary CTA sends the user. Reuses the existing billing route. */
+const UPGRADE_ROUTE = '/dashboard/billing';
+
+/** Plan id(s) that should see the banner. Everything else is treated as paid. */
+const FREE_PLAN_ID: string = 'starter';
+
+interface UpgradeHighlight {
+  icon: typeof Phone;
+  label: string;
+}
+
+const UPGRADE_HIGHLIGHTS: UpgradeHighlight[] = [
+  { icon: Phone, label: 'AI Receptionist' },
+  { icon: CalendarClock, label: 'Appointment Booking' },
+  { icon: RefreshCw, label: 'CRM Sync' },
+  { icon: ShieldAlert, label: 'Emergency Dispatch' },
+  { icon: Zap, label: 'Advanced Automation' },
+];
+
+// ============================================================
+// DISMISSAL PERSISTENCE
+// ============================================================
+//
+// Kept as small, isolated functions (rather than inlined in the component)
+// so the storage strategy can later be swapped for a Supabase-backed one
+// — e.g. a `upgrade_banner_dismissed_at` column on `profiles` — without
+// touching any rendering logic below. `refreshProfile()` from AuthContext
+// already exists for that future wiring.
+
+function readDismissed(userId: string): boolean {
+  try {
+    return window.localStorage.getItem(`${DISMISS_STORAGE_PREFIX}:${userId}`) === '1';
+  } catch {
+    // Storage may be unavailable (Safari private mode, disabled cookies, etc).
+    // Fail open to "not dismissed" — worst case the banner reappears.
+    return false;
+  }
+}
+
+function persistDismissed(userId: string) {
+  try {
+    window.localStorage.setItem(`${DISMISS_STORAGE_PREFIX}:${userId}`, '1');
+  } catch {
+    // Non-fatal: the banner simply won't remember the dismissal this session.
+  }
+}
+
+/**
+ * Encapsulates all "should the banner show" logic:
+ * - only Free (starter) plan users
+ * - not while the profile is still loading (avoids a flash for paid users)
+ * - not if this specific user previously dismissed it on this device
+ */
+function useUpgradeBannerVisibility() {
+  const { user, profile, profileLoading } = useAuth();
+  const [dismissed, setDismissed] = useState<boolean>(true);
+  const [hydrated, setHydrated] = useState(false);
+
+  useEffect(() => {
+    if (!user) {
+      setHydrated(false);
+      return;
+    }
+    setDismissed(readDismissed(user.id));
+    setHydrated(true);
+  }, [user]);
+
+  const isFreePlan = profile?.plan === FREE_PLAN_ID;
+  const visible = hydrated && !profileLoading && isFreePlan && !dismissed;
+
+  const dismiss = useCallback(() => {
+    if (!user) return;
+    persistDismissed(user.id);
+    setDismissed(true);
+  }, [user]);
+
+  return { visible, dismiss };
+}
+
+// ============================================================
+// COMPONENT
+// ============================================================
+
+export function UpgradeBanner() {
+  const { visible, dismiss } = useUpgradeBannerVisibility();
+  const navigate = useNavigate();
+  const [navigating, setNavigating] = useState(false);
+
+  const handleUpgrade = useCallback(() => {
+    setNavigating(true);
+    navigate(UPGRADE_ROUTE);
+  }, [navigate]);
+
+  return (
+    <AnimatePresence>
+      {visible && (
+        <motion.div
+          initial={{ opacity: 0, y: -16, scale: 0.98 }}
+          animate={{ opacity: 1, y: 0, scale: 1 }}
+          exit={{ opacity: 0, y: -12, scale: 0.98, transition: { duration: 0.2 } }}
+          transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
+          role="region"
+          aria-label="Upgrade to the Professional plan"
+          className="relative mb-6 overflow-hidden rounded-2xl border border-accent/20 bg-gradient-to-br from-accent/10 via-bg-secondary to-cta/10 p-5 shadow-card backdrop-blur-xl dark:shadow-card-dark sm:p-6"
+        >
+          {/* Decorative ambient glow — purely visual, hidden from assistive tech */}
+          <div
+            aria-hidden="true"
+            className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full bg-cta/20 blur-3xl"
+          />
+          <div
+            aria-hidden="true"
+            className="pointer-events-none absolute -bottom-14 -left-10 h-40 w-40 rounded-full bg-accent/20 blur-3xl"
+          />
+
+          <div className="relative flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
+            <div className="flex items-start gap-4">
+              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-accent to-cta text-white shadow-glow-accent">
+                <Rocket size={22} strokeWidth={2.25} />
+              </span>
+
+              <div className="min-w-0">
+                <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-accent">
+                  <Sparkles size={12} />
+                  You&apos;re on the Vireek Free Plan
+                </p>
+                <h3 className="mt-1 text-base font-bold leading-snug text-text-primary sm:text-lg">
+                  Upgrade to Professional and unlock:
+                </h3>
+                <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5">
+                  {UPGRADE_HIGHLIGHTS.map(({ icon: Icon, label }) => (
+                    <span
+                      key={label}
+                      className="flex items-center gap-1.5 text-xs font-medium text-text-secondary"
+                    >
+                      <Icon size={13} className="shrink-0 text-accent" />
+                      {label}
+                    </span>
+                  ))}
+                </div>
+              </div>
+            </div>
+
+            <div className="flex shrink-0 items-center gap-2 self-end sm:self-center">
+              <button
+                type="button"
+                onClick={handleUpgrade}
+                disabled={navigating}
+                className="focus-ring flex items-center gap-2 whitespace-nowrap rounded-xl bg-cta px-5 py-2.5 text-sm font-semibold text-white shadow-glow-cta transition-all duration-150 ease-out hover:brightness-110 active:brightness-95 disabled:cursor-not-allowed disabled:opacity-60"
+              >
+                {navigating ? (
+                  <>
+                    <Loader2 size={15} className="animate-spin" aria-hidden="true" />
+                    <span>Loading…</span>
+                  </>
+                ) : (
+                  <>
+                    Upgrade Plan
+                    <ArrowRight size={15} aria-hidden="true" />
+                  </>
+                )}
+              </button>
+
+              <button
+                type="button"
+                onClick={dismiss}
+                aria-label="Dismiss upgrade banner"
+                className="focus-ring flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-text-secondary/70 transition-colors duration-150 hover:bg-bg-tertiary hover:text-text-primary"
+              >
+                <X size={16} />
+              </button>
+            </div>
+          </div>
+        </motion.div>
+      )}
+    </AnimatePresence>
+  );
+}
diff -ruN '--exclude=vite.config.ts.timestamp*' a/src/components/sections/Industries.tsx b/src/components/sections/Industries.tsx
--- a/src/components/sections/Industries.tsx	2026-08-30 17:34:42.000000000 +0000
+++ b/src/components/sections/Industries.tsx	2026-08-31 04:36:46.418928513 +0000
@@ -1,35 +1,9 @@
 import { motion } from 'framer-motion';
-import { Flame, Droplets, Home, Zap, Wind } from 'lucide-react';
+import { ArrowRight } from 'lucide-react';
+import { Link } from 'react-router-dom';
 import { Card } from '@/components/ui/Card';
 import { EASE, eyebrowClass, sectionHeadingClass, bodyClass, staggerContainer, fadeUpItem, viewport } from '@/lib/motion';
-
-const INDUSTRIES = [
-  {
-    icon: Wind,
-    name: 'HVAC',
-    terms: ['AC repair', 'furnace issues', 'heat pumps', 'no heat', 'no cool', 'thermostat problems'],
-  },
-  {
-    icon: Droplets,
-    name: 'Plumbing',
-    terms: ['Burst pipes', 'leaks', 'drain cleaning', 'water heaters', 'sewer backup', 'low pressure'],
-  },
-  {
-    icon: Home,
-    name: 'Roofing',
-    terms: ['Leak repair', 'storm damage', 'missing shingles', 'gutter issues', 'flashing', 'ice dams'],
-  },
-  {
-    icon: Zap,
-    name: 'Electrical',
-    terms: ['Power issues', 'breaker problems', 'flickering lights', 'panel upgrades', 'GFCI'],
-  },
-  {
-    icon: Flame,
-    name: 'Restoration',
-    terms: ['Flood extraction', 'structural drying', 'smoke damage', 'mold remediation', 'board-up'],
-  },
-];
+import { INDUSTRIES } from '@/lib/industries';
 
 export function Industries() {
   return (
@@ -57,9 +31,9 @@
           viewport={viewport}
           className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-3"
         >
-          {INDUSTRIES.map(({ icon: Icon, name, terms }) => (
+          {INDUSTRIES.map(({ icon: Icon, name, slug, terms }) => (
             <motion.div key={name} variants={fadeUpItem} transition={{ duration: 0.5, ease: EASE }}>
-              <Card className="h-full">
+              <Card className="flex h-full flex-col">
                 <div className="flex items-center gap-3">
                   <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent">
                     <Icon size={20} />
@@ -76,6 +50,13 @@
                     </li>
                   ))}
                 </ul>
+                <Link
+                  to={`/industries/${slug}`}
+                  className="focus-ring mt-6 inline-flex items-center gap-1.5 text-sm font-semibold text-accent transition-colors hover:text-cta"
+                >
+                  See how Vireek helps {name.toLowerCase()}
+                  <ArrowRight size={14} />
+                </Link>
               </Card>
             </motion.div>
           ))}
diff -ruN '--exclude=vite.config.ts.timestamp*' a/src/components/sections/WhyVireek.tsx b/src/components/sections/WhyVireek.tsx
--- a/src/components/sections/WhyVireek.tsx	1970-01-01 00:00:00.000000000 +0000
+++ b/src/components/sections/WhyVireek.tsx	2026-08-30 19:03:10.657982586 +0000
@@ -0,0 +1,148 @@
+import { motion } from 'framer-motion';
+import { Check, X, Minus, Sparkles } from 'lucide-react';
+import { EASE, sectionHeadingClass, eyebrowClass, staggerContainer, fadeUpItem, viewport } from '@/lib/motion';
+
+// ============================================================
+// DATA
+// ============================================================
+//
+// Deliberately compares against generic categories ("Traditional
+// Answering Service", "Voicemail / Missed Calls") rather than any
+// named competitor brand — every claim here is a factual, defensible
+// statement about how each category of solution typically behaves.
+
+type CellValue = 'yes' | 'no' | 'partial';
+
+interface ComparisonRow {
+  label: string;
+  vireek: CellValue;
+  answeringService: CellValue;
+  voicemail: CellValue;
+}
+
+const ROWS: ComparisonRow[] = [
+  { label: 'Answers every call, 24/7/365', vireek: 'yes', answeringService: 'partial', voicemail: 'no' },
+  { label: 'Books appointments automatically', vireek: 'yes', answeringService: 'no', voicemail: 'no' },
+  { label: 'Captures & qualifies leads instantly', vireek: 'yes', answeringService: 'partial', voicemail: 'no' },
+  { label: 'Syncs to your CRM in real time', vireek: 'yes', answeringService: 'no', voicemail: 'no' },
+  { label: 'Flags true emergencies for dispatch', vireek: 'yes', answeringService: 'partial', voicemail: 'no' },
+  { label: 'No hold times or hiring / training', vireek: 'yes', answeringService: 'no', voicemail: 'yes' },
+  { label: 'Live insights & call analytics', vireek: 'yes', answeringService: 'no', voicemail: 'no' },
+];
+
+function Cell({ value }: { value: CellValue }) {
+  if (value === 'yes') {
+    return (
+      <span className="mx-auto flex h-7 w-7 items-center justify-center rounded-full bg-success-500/15 text-success-500">
+        <Check size={15} strokeWidth={2.75} />
+      </span>
+    );
+  }
+  if (value === 'partial') {
+    return (
+      <span className="mx-auto flex h-7 w-7 items-center justify-center rounded-full bg-warning-500/15 text-warning-500">
+        <Minus size={15} strokeWidth={2.75} />
+      </span>
+    );
+  }
+  return (
+    <span className="mx-auto flex h-7 w-7 items-center justify-center rounded-full bg-danger/10 text-danger">
+      <X size={15} strokeWidth={2.75} />
+    </span>
+  );
+}
+
+// ============================================================
+// SECTION
+// ============================================================
+
+export function WhyVireek() {
+  return (
+    <section className="py-24 md:py-28">
+      <div className="mx-auto max-w-6xl px-6">
+        <motion.div
+          initial={{ opacity: 0, y: 16 }}
+          whileInView={{ opacity: 1, y: 0 }}
+          viewport={viewport}
+          transition={{ duration: 0.5, ease: EASE }}
+          className="mx-auto max-w-2xl text-center"
+        >
+          <p className={eyebrowClass()}>The Comparison</p>
+          <h2 className={sectionHeadingClass()}>
+            Why home service teams are switching to Vireek
+          </h2>
+          <p className="mt-4 text-base leading-relaxed text-text-secondary">
+            See how an always-on AI receptionist stacks up against the two ways most
+            businesses handle calls today.
+          </p>
+        </motion.div>
+
+        <motion.div
+          initial={{ opacity: 0, y: 20 }}
+          whileInView={{ opacity: 1, y: 0 }}
+          viewport={viewport}
+          transition={{ duration: 0.6, ease: EASE, delay: 0.1 }}
+          className="mt-14 overflow-hidden rounded-2xl border border-border bg-bg-secondary shadow-card dark:shadow-card-dark"
+        >
+          <div className="overflow-x-auto">
+            <table className="w-full min-w-[560px] border-collapse text-sm">
+              <thead>
+                <tr className="border-b border-border">
+                  <th className="w-1/2 px-6 py-5 text-left text-sm font-semibold text-text-secondary">
+                    Capability
+                  </th>
+                  <th className="px-4 py-5">
+                    <div className="mx-auto flex w-fit items-center gap-1.5 rounded-full bg-gradient-to-r from-accent to-cta px-3.5 py-1.5 text-xs font-bold text-white shadow-glow-accent">
+                      <Sparkles size={12} />
+                      Vireek
+                    </div>
+                  </th>
+                  <th className="px-4 py-5 text-center text-xs font-semibold text-text-secondary">
+                    Answering
+                    <br />
+                    Service
+                  </th>
+                  <th className="px-4 py-5 text-center text-xs font-semibold text-text-secondary">
+                    Voicemail /<br />
+                    Missed Calls
+                  </th>
+                </tr>
+              </thead>
+              <motion.tbody variants={staggerContainer} initial="initial" whileInView="whileInView" viewport={viewport}>
+                {ROWS.map((row, i) => (
+                  <motion.tr
+                    key={row.label}
+                    variants={fadeUpItem}
+                    transition={{ duration: 0.35, ease: EASE }}
+                    className={`${i !== ROWS.length - 1 ? 'border-b border-border/60' : ''} hover:bg-bg-tertiary/50`}
+                  >
+                    <td className="px-6 py-4 text-sm font-medium text-text-primary">{row.label}</td>
+                    <td className="bg-accent/5 px-4 py-4 text-center">
+                      <Cell value={row.vireek} />
+                    </td>
+                    <td className="px-4 py-4 text-center">
+                      <Cell value={row.answeringService} />
+                    </td>
+                    <td className="px-4 py-4 text-center">
+                      <Cell value={row.voicemail} />
+                    </td>
+                  </motion.tr>
+                ))}
+              </motion.tbody>
+            </table>
+          </div>
+        </motion.div>
+
+        <motion.p
+          initial={{ opacity: 0 }}
+          whileInView={{ opacity: 1 }}
+          viewport={viewport}
+          transition={{ duration: 0.5, ease: EASE }}
+          className="mt-5 text-center text-xs text-text-secondary/60"
+        >
+          &ldquo;Partial&rdquo; reflects that outcome typically depending on staffing, hours, or manual follow-up.
+        </motion.p>
+      </div>
+    </section>
+  );
+}
diff -ruN '--exclude=vite.config.ts.timestamp*' a/src/contexts/AuthContext.tsx b/src/contexts/AuthContext.tsx
--- a/src/contexts/AuthContext.tsx	2026-08-30 17:34:42.000000000 +0000
+++ b/src/contexts/AuthContext.tsx	2026-08-31 04:29:46.308502784 +0000
@@ -49,13 +49,28 @@
   const fetchProfile = useCallback(async (userId: string) => {
     setProfileLoading(true);
     try {
-      const { data, error } = await supabase
-        .from('profiles')
-        .select('*')
-        .eq('id', userId)
-        .maybeSingle();
-      if (error) throw error;
-      const prof = data as Profile | null;
+      // The `profiles` row is created by a database trigger right after
+      // auth signup (email or OAuth). That trigger can lag the client by a
+      // few hundred ms, so a query fired immediately after signup can race
+      // it and come back empty. Retry briefly instead of accepting a false
+      // "no profile" result — this is what previously caused things like
+      // the upgrade banner to silently stay hidden for freshly created
+      // (especially Google OAuth) accounts until a manual refresh.
+      let prof: Profile | null = null;
+      const maxAttempts = 4;
+      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
+        const { data, error } = await supabase
+          .from('profiles')
+          .select('*')
+          .eq('id', userId)
+          .maybeSingle();
+        if (error) throw error;
+        prof = data as Profile | null;
+        if (prof) break;
+        if (attempt < maxAttempts) {
+          await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
+        }
+      }
       setProfile(prof);
 
       // If not an owner, fetch their team_members record for permissions
diff -ruN '--exclude=vite.config.ts.timestamp*' a/src/lib/industries.ts b/src/lib/industries.ts
--- a/src/lib/industries.ts	1970-01-01 00:00:00.000000000 +0000
+++ b/src/lib/industries.ts	2026-08-31 04:35:55.816928313 +0000
@@ -0,0 +1,161 @@
+import { Flame, Droplets, Home, Zap, Wind, type LucideIcon } from 'lucide-react';
+
+export interface IndustryFAQ {
+  q: string;
+  a: string;
+}
+
+export interface Industry {
+  slug: string;
+  name: string;
+  /** Short plural used in headings, e.g. "plumbers", "HVAC teams" */
+  audience: string;
+  icon: LucideIcon;
+  tagline: string;
+  /** Common call reasons — reused from the homepage Industries section */
+  terms: string[];
+  /** Pain points this trade specifically deals with */
+  painPoints: string[];
+  /** How Vireek handles calls for this trade, specifically */
+  capabilities: string[];
+  faq: IndustryFAQ[];
+}
+
+export const INDUSTRIES: Industry[] = [
+  {
+    slug: 'hvac',
+    name: 'HVAC',
+    audience: 'HVAC companies',
+    icon: Wind,
+    tagline: 'Never lose a no-heat or no-cool call to voicemail again.',
+    terms: ['AC repair', 'furnace issues', 'heat pumps', 'no heat', 'no cool', 'thermostat problems'],
+    painPoints: [
+      'No-heat and no-cool calls spike exactly when your team is already slammed on a job.',
+      'After-hours emergency calls go to voicemail and the customer calls a competitor instead.',
+      'Dispatchers waste time on calls that turn out to be simple filter or thermostat questions.',
+    ],
+    capabilities: [
+      'Answers every call day or night and asks the right triage questions (system type, symptoms, how long it\u2019s been out).',
+      'Books service appointments directly onto your calendar based on your real availability.',
+      'Flags true no-heat/no-cool emergencies for immediate dispatch instead of sitting in a queue.',
+    ],
+    faq: [
+      {
+        q: 'Can it tell the difference between an emergency and a routine maintenance call?',
+        a: 'Yes. Vireek is configured with your escalation rules, so language indicating no heat, no cooling, or safety concerns is flagged for immediate follow-up, while routine requests are booked normally.',
+      },
+      {
+        q: 'Does it know basic HVAC terminology?',
+        a: 'Yes. Vireek is set up with HVAC-specific vocabulary — heat pumps, furnaces, thermostats, refrigerant, ductwork — so callers don\u2019t have to explain themselves twice.',
+      },
+      {
+        q: 'Can it handle seasonal call spikes?',
+        a: 'Yes. Because Vireek answers every call instantly regardless of volume, seasonal surges (first heat wave, first cold snap) don\u2019t create hold times or missed calls.',
+      },
+    ],
+  },
+  {
+    slug: 'plumbing',
+    name: 'Plumbing',
+    audience: 'plumbing companies',
+    icon: Droplets,
+    tagline: 'Burst pipes don\u2019t wait for business hours. Neither should your receptionist.',
+    terms: ['Burst pipes', 'leaks', 'drain cleaning', 'water heaters', 'sewer backup', 'low pressure'],
+    painPoints: [
+      'A burst pipe at 2am is either an answered call and a loyal customer, or a missed call and a Google review.',
+      'Office staff spend hours a week just relaying appointment requests instead of running the business.',
+      'Low-priority calls (a running toilet) and true emergencies (sewer backup) get treated the same way.',
+    ],
+    capabilities: [
+      'Picks up instantly, 24/7, so emergency leaks and backups get triaged the moment they happen.',
+      'Captures address, issue, and urgency, then books or escalates based on your rules.',
+      'Syncs every call and booking straight into your CRM — no manual re-entry.',
+    ],
+    faq: [
+      {
+        q: 'Can Vireek prioritize a sewer backup over a slow drain?',
+        a: 'Yes. You define what counts as urgent, and Vireek routes those calls for immediate dispatch while booking non-urgent requests into your normal schedule.',
+      },
+      {
+        q: 'Will callers know they\u2019re not talking to a person?',
+        a: 'Vireek is upfront and conversational, and is built to gather the same details a trained dispatcher would — without hold music or a full voicemail box.',
+      },
+    ],
+  },
+  {
+    slug: 'roofing',
+    name: 'Roofing',
+    audience: 'roofing companies',
+    icon: Home,
+    tagline: 'Storm season floods your phone lines. Vireek never gets overwhelmed.',
+    terms: ['Leak repair', 'storm damage', 'missing shingles', 'gutter issues', 'flashing', 'ice dams'],
+    painPoints: [
+      'After a storm, call volume can 10x overnight — and every missed call is a lead going to a competitor.',
+      'Insurance-related calls need specific details captured accurately the first time.',
+      'Sales and field teams can\u2019t answer phones while they\u2019re on a roof.',
+    ],
+    capabilities: [
+      'Handles unlimited simultaneous calls, so a storm surge never means a busy signal.',
+      'Captures damage details and contact info consistently, ready for your estimating team.',
+      'Books inspection appointments automatically based on real crew availability.',
+    ],
+    faq: [
+      {
+        q: 'Can it handle a sudden spike in calls after a storm?',
+        a: 'Yes — this is one of the biggest reasons roofing companies use Vireek. It answers every call simultaneously with no hold queue, no matter how many come in at once.',
+      },
+    ],
+  },
+  {
+    slug: 'electrical',
+    name: 'Electrical',
+    audience: 'electrical contractors',
+    icon: Zap,
+    tagline: 'From flickering lights to a dead panel, every call gets answered.',
+    terms: ['Power issues', 'breaker problems', 'flickering lights', 'panel upgrades', 'GFCI'],
+    painPoints: [
+      'Safety-related calls (sparking outlets, burning smells) need to be flagged and escalated immediately.',
+      'Estimate requests for panel upgrades often come in after hours when the office is closed.',
+      'Techs in the field can\u2019t stop to answer the phone mid-job.',
+    ],
+    capabilities: [
+      'Recognizes safety-critical language and escalates it immediately per your rules.',
+      'Books estimates and service calls straight onto your calendar, any time of day.',
+      'Gives you a clean, searchable log of every call and outcome.',
+    ],
+    faq: [
+      {
+        q: 'Does it recognize an electrical emergency versus a routine request?',
+        a: 'Yes. You configure the trigger language (sparking, burning smell, no power) and Vireek escalates those calls immediately instead of just booking a normal appointment.',
+      },
+    ],
+  },
+  {
+    slug: 'restoration',
+    name: 'Restoration',
+    audience: 'restoration companies',
+    icon: Flame,
+    tagline: 'Water and fire damage calls are always urgent. Vireek treats them that way.',
+    terms: ['Flood extraction', 'structural drying', 'smoke damage', 'mold remediation', 'board-up'],
+    painPoints: [
+      'Restoration calls are almost always time-sensitive — every hour of delay can mean more damage.',
+      'Insurance claims require accurate, consistently captured information from the first call.',
+      'Crews are on active job sites and can\u2019t staff a 24/7 phone line themselves.',
+    ],
+    capabilities: [
+      'Answers immediately, any hour, and captures the details your crew needs before they even arrive.',
+      'Flags active flooding, fire damage, or safety hazards for instant dispatch.',
+      'Keeps a full record of every call for insurance and follow-up purposes.',
+    ],
+    faq: [
+      {
+        q: 'Can Vireek dispatch a crew immediately for active flooding?',
+        a: 'Vireek captures the details and triggers your defined escalation path (SMS, call transfer, or team alert) so your on-call crew is notified right away.',
+      },
+    ],
+  },
+];
+
+export function getIndustryBySlug(slug: string | undefined): Industry | undefined {
+  return INDUSTRIES.find((i) => i.slug === slug);
+}
diff -ruN '--exclude=vite.config.ts.timestamp*' a/src/pages/HomePage.tsx b/src/pages/HomePage.tsx
--- a/src/pages/HomePage.tsx	2026-08-30 17:34:42.000000000 +0000
+++ b/src/pages/HomePage.tsx	2026-08-30 19:03:19.581673895 +0000
@@ -10,12 +10,12 @@
 import { Industries } from '@/components/sections/Industries';
 import { LiveDemo } from '@/components/sections/LiveDemo';
 import { Features } from '@/components/sections/Features';
+import { WhyVireek } from '@/components/sections/WhyVireek';
 import { SocialProof } from '@/components/sections/SocialProof';
 import { Pricing } from '@/components/sections/Pricing';
 import { SignupForm } from '@/components/sections/SignupForm';
 import { FinalCTA } from '@/components/sections/FinalCTA';
 import { CookieConsent } from '@/components/CookieConsent';
-import { UpgradeBadge } from '@/components/UpgradeBadge';
 
 export function HomePage() {
   return (
@@ -31,6 +31,7 @@
         <Industries />
         <LiveDemo />
         <Features />
+        <WhyVireek />
         <SocialProof />
         <Pricing />
         <SignupForm />
@@ -38,7 +39,6 @@
       </main>
       <Footer />
       <CookieConsent />
-      <UpgradeBadge />
     </ThemeProvider>
   );
 }
diff -ruN '--exclude=vite.config.ts.timestamp*' a/src/pages/IndustryPage.tsx b/src/pages/IndustryPage.tsx
--- a/src/pages/IndustryPage.tsx	1970-01-01 00:00:00.000000000 +0000
+++ b/src/pages/IndustryPage.tsx	2026-08-31 04:36:25.816930096 +0000
@@ -0,0 +1,229 @@
+import { useEffect } from 'react';
+import { useParams, Link, Navigate } from 'react-router-dom';
+import { motion } from 'framer-motion';
+import { ArrowRight, Check, PhoneCall, Sparkles } from 'lucide-react';
+import { Header } from '@/components/Header';
+import { Footer } from '@/components/Footer';
+import { CookieConsent } from '@/components/CookieConsent';
+import { Button } from '@/components/ui/Button';
+import { Card } from '@/components/ui/Card';
+import { EASE, eyebrowClass, sectionHeadingClass, viewport } from '@/lib/motion';
+import { getIndustryBySlug, INDUSTRIES } from '@/lib/industries';
+
+function SEO({ name, audience, tagline }: { name: string; audience: string; tagline: string }) {
+  useEffect(() => {
+    const title = `AI Receptionist for ${name} ${name === 'HVAC' ? 'Companies' : ''} | Vireek`.replace(/\s+/g, ' ').trim();
+    const description = `${tagline} Vireek answers every call, books appointments, and captures leads for ${audience} — 24/7, no missed calls.`;
+    const previousTitle = document.title;
+
+    const upsertMeta = (name_: string, content: string) => {
+      let meta = document.querySelector<HTMLMetaElement>(`meta[name="${name_}"]`);
+      if (!meta) {
+        meta = document.createElement('meta');
+        meta.setAttribute('name', name_);
+        document.head.appendChild(meta);
+      }
+      const previous = meta.getAttribute('content');
+      meta.setAttribute('content', content);
+      return () => {
+        if (previous === null) meta?.remove();
+        else meta?.setAttribute('content', previous);
+      };
+    };
+
+    document.title = title;
+    const cleanupDescription = upsertMeta('description', description);
+    const cleanupRobots = upsertMeta('robots', 'index, follow');
+
+    return () => {
+      document.title = previousTitle;
+      cleanupDescription();
+      cleanupRobots();
+    };
+  }, [name, audience, tagline]);
+
+  return null;
+}
+
+export function IndustryPage() {
+  const { slug } = useParams<{ slug: string }>();
+  const industry = getIndustryBySlug(slug);
+
+  if (!industry) {
+    return <Navigate to="/#industries" replace />;
+  }
+
+  const { name, audience, tagline, painPoints, capabilities, faq, icon: Icon } = industry;
+  const otherIndustries = INDUSTRIES.filter((i) => i.slug !== industry.slug);
+
+  return (
+    <>
+      <SEO name={name} audience={audience} tagline={tagline} />
+      <Header />
+      <main className="min-h-screen overflow-hidden bg-bg-primary pt-24">
+        {/* Hero */}
+        <section className="relative bg-gradient-mesh bg-noise px-6 py-20 sm:py-24 lg:py-28">
+          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />
+          <div className="mx-auto max-w-4xl text-center">
+            <motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55, ease: EASE }}>
+              <div className="mx-auto mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-bg-secondary/80 px-4 py-2 text-sm font-semibold text-text-secondary shadow-sm backdrop-blur">
+                <Icon className="h-4 w-4 text-accent" />
+                Built for {audience}
+              </div>
+              <h1 className="text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl lg:text-6xl">
+                The AI Receptionist for {name}
+              </h1>
+              <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-text-secondary sm:text-xl">{tagline}</p>
+              <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
+                <Link to="/signup">
+                  <Button variant="primary" size="lg">
+                    Start Free Trial
+                  </Button>
+                </Link>
+                <a
+                  href="/#pricing"
+                  className="focus-ring inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-text-primary transition-colors hover:text-accent"
+                >
+                  View pricing <ArrowRight className="h-4 w-4" />
+                </a>
+              </div>
+            </motion.div>
+          </div>
+        </section>
+
+        {/* Pain points vs capabilities */}
+        <section className="px-6 py-16 sm:py-20">
+          <div className="mx-auto grid max-w-6xl gap-8 lg:grid-cols-2">
+            <motion.div
+              initial={{ opacity: 0, y: 16 }}
+              whileInView={{ opacity: 1, y: 0 }}
+              viewport={viewport}
+              transition={{ duration: 0.5, ease: EASE }}
+            >
+              <Card className="h-full">
+                <p className={eyebrowClass()}>The Problem</p>
+                <h2 className="mt-2 text-2xl font-bold text-text-primary">
+                  What {audience} deal with every day
+                </h2>
+                <ul className="mt-6 space-y-4">
+                  {painPoints.map((point) => (
+                    <li key={point} className="flex gap-3 text-sm leading-relaxed text-text-secondary">
+                      <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-danger" />
+                      {point}
+                    </li>
+                  ))}
+                </ul>
+              </Card>
+            </motion.div>
+
+            <motion.div
+              initial={{ opacity: 0, y: 16 }}
+              whileInView={{ opacity: 1, y: 0 }}
+              viewport={viewport}
+              transition={{ duration: 0.5, ease: EASE, delay: 0.1 }}
+            >
+              <Card className="h-full border-accent/25">
+                <p className={eyebrowClass()}>How Vireek Helps</p>
+                <h2 className="mt-2 text-2xl font-bold text-text-primary">Built specifically for {name.toLowerCase()}</h2>
+                <ul className="mt-6 space-y-4">
+                  {capabilities.map((cap) => (
+                    <li key={cap} className="flex gap-3 text-sm leading-relaxed text-text-secondary">
+                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" />
+                      {cap}
+                    </li>
+                  ))}
+                </ul>
+              </Card>
+            </motion.div>
+          </div>
+        </section>
+
+        {/* Common call types */}
+        <section className="px-6 py-16 sm:py-20">
+          <div className="mx-auto max-w-4xl text-center">
+            <p className={eyebrowClass()}>Common Calls</p>
+            <h2 className={sectionHeadingClass()}>Calls Vireek handles for {audience}</h2>
+            <div className="mt-8 flex flex-wrap justify-center gap-3">
+              {industry.terms.map((term) => (
+                <span
+                  key={term}
+                  className="rounded-lg border border-border bg-bg-tertiary px-4 py-2 text-sm text-text-secondary"
+                >
+                  {term}
+                </span>
+              ))}
+            </div>
+          </div>
+        </section>
+
+        {/* FAQ */}
+        {faq.length > 0 && (
+          <section className="px-6 py-16 sm:py-20">
+            <div className="mx-auto max-w-3xl">
+              <p className={`${eyebrowClass()} text-center`}>FAQ</p>
+              <h2 className={`${sectionHeadingClass()} text-center`}>
+                Questions {audience} ask us
+              </h2>
+              <div className="mt-10 space-y-4">
+                {faq.map((item) => (
+                  <div key={item.q} className="rounded-2xl border border-border bg-bg-secondary/90 p-6 shadow-card dark:shadow-card-dark">
+                    <h3 className="text-base font-semibold text-text-primary">{item.q}</h3>
+                    <p className="mt-2 text-sm leading-relaxed text-text-secondary">{item.a}</p>
+                  </div>
+                ))}
+              </div>
+            </div>
+          </section>
+        )}
+
+        {/* Explore other trades — internal linking for SEO + discovery */}
+        <section className="px-6 py-16 sm:py-20">
+          <div className="mx-auto max-w-5xl">
+            <p className={`${eyebrowClass()} text-center`}>Other Trades</p>
+            <h2 className={`${sectionHeadingClass()} text-center`}>Vireek also works for</h2>
+            <div className="mt-8 flex flex-wrap justify-center gap-3">
+              {otherIndustries.map((other) => (
+                <Link
+                  key={other.slug}
+                  to={`/industries/${other.slug}`}
+                  className="focus-ring inline-flex items-center gap-2 rounded-xl border border-border bg-bg-secondary px-4 py-2.5 text-sm font-semibold text-text-primary transition-colors hover:border-accent/40 hover:text-accent"
+                >
+                  <other.icon className="h-4 w-4" />
+                  {other.name}
+                </Link>
+              ))}
+            </div>
+          </div>
+        </section>
+
+        {/* Final CTA */}
+        <section className="px-6 pb-24">
+          <div className="mx-auto max-w-5xl rounded-[2rem] border border-border bg-bg-secondary p-8 text-center shadow-card dark:shadow-card-dark sm:p-12">
+            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-accent">
+              <Sparkles className="mr-1.5 inline h-4 w-4" />
+              Ready when your phone rings
+            </p>
+            <h2 className="mt-4 text-3xl font-bold tracking-tight text-text-primary sm:text-4xl">
+              Stop losing {name.toLowerCase()} leads to voicemail.
+            </h2>
+            <p className="mx-auto mt-4 max-w-2xl text-base leading-7 text-text-secondary">
+              Set up Vireek in minutes and start answering every call today.
+            </p>
+            <div className="mt-8 flex flex-col items-center justify-center gap-4 sm:flex-row">
+              <Link to="/signup">
+                <Button variant="primary" size="lg">
+                  Start Free Trial
+                </Button>
+              </Link>
+              <a href="tel:+16509106703" className="focus-ring inline-flex items-center gap-2 text-sm font-semibold text-text-secondary hover:text-accent">
+                <PhoneCall className="h-4 w-4" /> Or call our demo line
+              </a>
+            </div>
+          </div>
+        </section>
+      </main>
+      <Footer />
+      <CookieConsent />
+    </>
+  );
+}
diff -ruN '--exclude=vite.config.ts.timestamp*' a/src/pages/SignupPage.tsx b/src/pages/SignupPage.tsx
--- a/src/pages/SignupPage.tsx	2026-08-30 17:34:42.000000000 +0000
+++ b/src/pages/SignupPage.tsx	2026-08-30 19:15:20.346752473 +0000
@@ -7,6 +7,7 @@
   Loader as Loader2,
   CircleAlert as AlertCircle,
   X,
+  Check,
   CircleCheck as CheckCircle2,
   Mail,
   Lock,
@@ -104,6 +105,7 @@
   const [nameTouched, setNameTouched] = useState(false);
   const [emailTouched, setEmailTouched] = useState(false);
   const [confirmTouched, setConfirmTouched] = useState(false);
+  const [passwordTouched, setPasswordTouched] = useState(false);
 
   const [nameError, setNameError] = useState('');
   const [emailError, setEmailError] = useState('');
@@ -150,7 +152,10 @@
   }, [confirmPassword, password]);
 
   const strength = useMemo(() => getPasswordStrength(password), [password]);
-  const passwordMeetsPolicy = password.length >= 8 && /[0-9]/.test(password) && /[^A-Za-z0-9]/.test(password);
+  const hasMinLength = password.length >= 8;
+  const hasNumber = /[0-9]/.test(password);
+  const hasSymbol = /[^A-Za-z0-9]/.test(password);
+  const passwordMeetsPolicy = hasMinLength && hasNumber && hasSymbol;
 
   const isFormValid =
     fullName.trim().length >= 2 &&
@@ -457,9 +462,15 @@
                   autoComplete="new-password"
                   value={password}
                   onChange={(e) => setPassword(e.target.value)}
+                  onBlur={() => setPasswordTouched(true)}
                   placeholder="Create a password"
-                  aria-describedby="password-help"
-                  className="focus-ring w-full rounded-xl border border-border bg-bg-primary py-3 pl-11 pr-11 text-base text-text-primary placeholder:text-text-secondary/50 transition-colors focus-visible:border-accent"
+                  aria-invalid={passwordTouched && !passwordMeetsPolicy}
+                  aria-describedby="password-requirements"
+                  className={`focus-ring w-full rounded-xl border bg-bg-primary py-3 pl-11 pr-11 text-base text-text-primary placeholder:text-text-secondary/50 transition-colors ${
+                    passwordTouched && !passwordMeetsPolicy
+                      ? 'border-danger/50 focus-visible:border-danger'
+                      : 'border-border focus-visible:border-accent'
+                  }`}
                 />
                 <button
                   type="button"
@@ -490,9 +501,35 @@
                   </span>
                 </div>
               )}
-              <p id="password-help" className="mt-1.5 text-xs text-text-secondary/60">
-                Min 8 characters with at least one number and one symbol.
-              </p>
+              {/* Live requirement checklist — makes it obvious exactly why the
+                  submit button is disabled, instead of it silently staying grey. */}
+              <ul id="password-requirements" className="mt-2 space-y-1">
+                {[
+                  { met: hasMinLength, label: 'At least 8 characters' },
+                  { met: hasNumber, label: 'At least one number' },
+                  { met: hasSymbol, label: 'At least one symbol (e.g. ! @ # $ %)' },
+                ].map(({ met, label }) => (
+                  <li
+                    key={label}
+                    className={`flex items-center gap-1.5 text-xs transition-colors ${
+                      met
+                        ? 'text-success-500'
+                        : passwordTouched
+                          ? 'text-danger'
+                          : 'text-text-secondary/60'
+                    }`}
+                  >
+                    {met ? (
+                      <Check size={12} className="shrink-0" />
+                    ) : passwordTouched ? (
+                      <X size={12} className="shrink-0" />
+                    ) : (
+                      <span className="ml-[1px] h-1 w-1 shrink-0 rounded-full bg-current" />
+                    )}
+                    {label}
+                  </li>
+                ))}
+              </ul>
             </div>
 
             {/* Confirm Password */}

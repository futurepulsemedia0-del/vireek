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

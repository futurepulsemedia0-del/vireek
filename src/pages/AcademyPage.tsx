import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { PlayCircle, CheckCircle2, GraduationCap, Clock } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/lib/supabase';
import { EASE } from '@/lib/motion';
import { useSEO } from '@/lib/seo';
import { ACADEMY_COURSES, getAllLessonIds, AcademyLesson } from '@/lib/academy';

function SEO() {
  useSEO({
    title: 'Vireek Academy — Free Video Training & Certification',
    description: 'Self-paced video lessons covering onboarding, the dashboard, and getting the most out of Sarah — with a completion certificate at the end.',
    canonical: 'https://vireek.com/academy',
  });
  return null;
}

const ALL_LESSON_IDS = getAllLessonIds();

export function AcademyPage() {
  const { user } = useAuth();
  const [activeLesson, setActiveLesson] = useState<AcademyLesson>(ACADEMY_COURSES[0].lessons[0]);
  const [completed, setCompleted] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) {
      setLoading(false);
      return;
    }
    supabase
      .from('academy_progress')
      .select('lesson_id')
      .eq('user_id', user.id)
      .then(({ data }) => {
        setCompleted(new Set((data ?? []).map((r) => r.lesson_id as string)));
        setLoading(false);
      });
  }, [user]);

  const progressPct = Math.round((completed.size / ALL_LESSON_IDS.length) * 100);
  useEffect(() => {
    if (progressPct === 100 && user) {
      supabase.rpc('award_academy_badge_if_complete', { p_total_lessons: ALL_LESSON_IDS.length }).then(({ data: newlyAwarded }) => {
        if (newlyAwarded) toast('🎓 You completed Vireek Academy! Your certificate is ready.', 'success');
      });
    }
  }, [progressPct, user]);
  const allDone = completed.size === ALL_LESSON_IDS.length;

  const markComplete = async (lessonId: string) => {
    setCompleted((prev) => new Set(prev).add(lessonId));
    if (user) {
      await supabase.from('academy_progress').upsert({ user_id: user.id, lesson_id: lessonId }, { onConflict: 'user_id,lesson_id' });
    }
  };

  const nextLesson = useMemo(() => {
    const flat = ACADEMY_COURSES.flatMap((c) => c.lessons);
    const idx = flat.findIndex((l) => l.id === activeLesson.id);
    return flat[idx + 1];
  }, [activeLesson]);

  return (
    <>
      <SEO />
      <Header />
      <main className="min-h-screen bg-bg-primary pt-24">
        <section className="bg-gradient-mesh bg-noise px-6 py-14">
          <div className="mx-auto max-w-6xl">
            <div className="mb-6">
              <BackButton />
            </div>
            <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: EASE }}>
              <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-border bg-bg-secondary/80 px-4 py-2 text-sm font-semibold text-text-secondary shadow-sm backdrop-blur">
                <GraduationCap className="h-4 w-4 text-accent" />
                Vireek Academy
              </div>
              <h1 className="text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl">
                Learn Vireek at your own pace.
              </h1>
              <p className="mt-4 max-w-2xl text-lg text-text-secondary">
                Short videos covering everything in the{' '}
                <Link to="/onboarding-guide" className="font-semibold text-accent hover:underline">
                  written onboarding guide
                </Link>{' '}
                — finish every lesson and get a completion certificate.
              </p>
            </motion.div>

            {user && !loading && (
              <div className="mt-6 max-w-md">
                <div className="mb-1.5 flex items-center justify-between text-xs font-medium text-text-secondary">
                  <span>Your progress</span>
                  <span>{progressPct}%</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-bg-tertiary">
                  <div className="h-full rounded-full bg-gradient-to-r from-accent to-cta transition-all" style={{ width: `${progressPct}%` }} />
                </div>
                {allDone && (
                  <Link
                    to="/academy/certificate"
                    className="mt-3 inline-flex items-center gap-1.5 rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white transition-all hover:brightness-110"
                  >
                    <GraduationCap size={16} /> Get your certificate
                  </Link>
                )}
              </div>
            )}
          </div>
        </section>

        <section className="px-6 py-10">
          <div className="mx-auto grid max-w-6xl gap-8 lg:grid-cols-[1fr_360px]">
            <div>
              <div className="aspect-video w-full overflow-hidden rounded-2xl border border-border bg-black">
                <iframe
                  key={activeLesson.id}
                  src={activeLesson.videoUrl}
                  title={activeLesson.title}
                  className="h-full w-full"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                />
              </div>
              <h2 className="mt-5 text-xl font-bold text-text-primary">{activeLesson.title}</h2>
              <p className="mt-2 text-sm leading-relaxed text-text-secondary">{activeLesson.description}</p>

              <div className="mt-5 flex items-center gap-3">
                {!completed.has(activeLesson.id) ? (
                  <button
                    type="button"
                    onClick={() => markComplete(activeLesson.id)}
                    className="focus-ring flex items-center gap-1.5 rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white transition-all hover:brightness-110"
                  >
                    <CheckCircle2 size={16} /> Mark lesson complete
                  </button>
                ) : (
                  <span className="flex items-center gap-1.5 text-sm font-medium text-success-500">
                    <CheckCircle2 size={16} /> Completed
                  </span>
                )}
                {nextLesson && (
                  <button
                    type="button"
                    onClick={() => setActiveLesson(nextLesson)}
                    className="focus-ring rounded-xl border border-border px-4 py-2.5 text-sm font-medium text-text-secondary hover:text-text-primary"
                  >
                    Next lesson →
                  </button>
                )}
              </div>

              {!user && (
                <p className="mt-4 text-xs text-text-secondary">
                  <Link to="/signup" className="font-semibold text-accent hover:underline">
                    Create a free account
                  </Link>{' '}
                  to save your progress and earn a certificate.
                </p>
              )}
            </div>

            <aside className="space-y-6">
              {ACADEMY_COURSES.map((course) => (
                <div key={course.slug}>
                  <h3 className="mb-2 text-sm font-semibold text-text-primary">{course.title}</h3>
                  <div className="space-y-1.5">
                    {course.lessons.map((lesson) => {
                      const isActive = lesson.id === activeLesson.id;
                      const isDone = completed.has(lesson.id);
                      return (
                        <button
                          key={lesson.id}
                          type="button"
                          onClick={() => setActiveLesson(lesson)}
                          className={`focus-ring flex w-full items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left text-sm transition-colors ${
                            isActive ? 'border-accent/40 bg-accent/5' : 'border-border bg-bg-secondary hover:border-accent/20'
                          }`}
                        >
                          {isDone ? (
                            <CheckCircle2 size={16} className="shrink-0 text-success-500" />
                          ) : (
                            <PlayCircle size={16} className="shrink-0 text-text-secondary" />
                          )}
                          <span className="min-w-0 flex-1 truncate text-text-primary">{lesson.title}</span>
                          <span className="flex shrink-0 items-center gap-1 text-[11px] text-text-secondary">
                            <Clock size={11} /> {lesson.minutes}m
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </aside>
          </div>
        </section>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Circle, GraduationCap, Award } from 'lucide-react';
import { PartnerPortalLayout } from '@/components/partner-portal/PartnerPortalLayout';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { supabase } from '@/lib/supabase';
import { useSEO } from '@/lib/seo';
import { PARTNER_LESSONS, PARTNER_QUIZ, PARTNER_QUIZ_PASS_PERCENT, getAllPartnerLessonIds } from '@/lib/partnerAcademy';

function SEO() {
  useSEO({
    title: 'Partner Certification — Vireek Partner Portal',
    description: 'Complete the Vireek partner certification course and quiz to earn your certificate.',
    canonical: 'https://vireek.com/partner-portal/certification',
  });
  return null;
}

export function PartnerPortalCertificationPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [completedIds, setCompletedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [alreadyCertified, setAlreadyCertified] = useState(false);
  const [showQuiz, setShowQuiz] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{ score: number; passed: boolean } | null>(null);
  const [submittingQuiz, setSubmittingQuiz] = useState(false);

  useEffect(() => {
    if (!user) return;
    Promise.all([
      supabase.from('partner_academy_progress').select('lesson_id').eq('user_id', user.id),
      supabase.from('partner_certifications').select('user_id').eq('user_id', user.id).maybeSingle(),
    ]).then(([progressRes, certRes]) => {
      setCompletedIds(new Set((progressRes.data || []).map((r) => r.lesson_id)));
      setAlreadyCertified(Boolean(certRes.data));
      setLoading(false);
    });
  }, [user]);

  const toggleLesson = async (lessonId: string) => {
    if (!user) return;
    const isDone = completedIds.has(lessonId);
    const next = new Set(completedIds);
    if (isDone) {
      next.delete(lessonId);
      setCompletedIds(next);
      await supabase.from('partner_academy_progress').delete().eq('user_id', user.id).eq('lesson_id', lessonId);
    } else {
      next.add(lessonId);
      setCompletedIds(next);
      await supabase.from('partner_academy_progress').insert({ user_id: user.id, lesson_id: lessonId });
    }
  };

  const allLessonsDone = getAllPartnerLessonIds().every((id) => completedIds.has(id));

  const submitQuiz = async () => {
    const correct = PARTNER_QUIZ.filter((q) => answers[q.id] === q.correctOptionId).length;
    const score = Math.round((correct / PARTNER_QUIZ.length) * 100);
    const passed = score >= PARTNER_QUIZ_PASS_PERCENT;
    setResult({ score, passed });

    if (passed) {
      setSubmittingQuiz(true);
      const { error } = await supabase.rpc('record_partner_certification', { p_score: score });
      setSubmittingQuiz(false);
      if (error) {
        toast('Passed, but saving your certificate failed — try submitting again.', 'error');
      } else {
        setAlreadyCertified(true);
        toast('Certification earned!', 'success');
      }
    }
  };

  if (loading) {
    return (
      <PartnerPortalLayout>
        <SEO />
        <div className="flex justify-center py-24">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-accent" />
        </div>
      </PartnerPortalLayout>
    );
  }

  if (alreadyCertified) {
    return (
      <PartnerPortalLayout>
        <SEO />
        <Card className="mx-auto mt-10 max-w-md text-center">
          <Award className="mx-auto h-10 w-10 text-accent" />
          <h1 className="mt-4 text-xl font-bold text-text-primary">You're certified</h1>
          <p className="mt-2 text-sm text-text-secondary">You've completed the Vireek Partner Certification course.</p>
          <Link to="/partner-portal/certificate" className="mt-6 inline-block">
            <Button variant="primary">View your certificate</Button>
          </Link>
        </Card>
      </PartnerPortalLayout>
    );
  }

  return (
    <PartnerPortalLayout>
      <SEO />
      <h1 className="text-2xl font-bold tracking-tight text-text-primary">Partner Certification</h1>
      <p className="mt-1 text-sm text-text-secondary">
        Work through {PARTNER_LESSONS.length} short lessons, then pass a {PARTNER_QUIZ.length}-question quiz
        ({PARTNER_QUIZ_PASS_PERCENT}%+ to pass) to earn your certificate.
      </p>

      {!showQuiz && (
        <div className="mt-6 space-y-3">
          {PARTNER_LESSONS.map((lesson) => {
            const done = completedIds.has(lesson.id);
            return (
              <Card key={lesson.id} className="!p-5">
                <button type="button" onClick={() => toggleLesson(lesson.id)} className="focus-ring flex w-full items-start gap-3 text-left">
                  {done ? (
                    <CheckCircle2 size={20} className="mt-0.5 shrink-0 text-success" />
                  ) : (
                    <Circle size={20} className="mt-0.5 shrink-0 text-text-secondary/50" />
                  )}
                  <div>
                    <p className="text-sm font-semibold text-text-primary">
                      {lesson.title} <span className="font-normal text-text-secondary">· {lesson.minutes} min</span>
                    </p>
                    <p className="mt-1 text-sm leading-relaxed text-text-secondary">{lesson.body}</p>
                  </div>
                </button>
              </Card>
            );
          })}

          <div className="pt-2">
            <Button variant="primary" disabled={!allLessonsDone} onClick={() => setShowQuiz(true)}>
              <GraduationCap size={18} />
              {allLessonsDone ? 'Take the quiz' : 'Complete all lessons to unlock the quiz'}
            </Button>
          </div>
        </div>
      )}

      {showQuiz && !result?.passed && (
        <div className="mt-6 space-y-4">
          {PARTNER_QUIZ.map((q, i) => (
            <Card key={q.id} className="!p-5">
              <p className="text-sm font-semibold text-text-primary">
                {i + 1}. {q.prompt}
              </p>
              <div className="mt-3 space-y-2">
                {q.options.map((opt) => (
                  <label
                    key={opt.id}
                    className={`focus-ring flex cursor-pointer items-center gap-2.5 rounded-xl border px-3.5 py-2.5 text-sm transition-colors ${
                      answers[q.id] === opt.id ? 'border-accent bg-accent/5 text-text-primary' : 'border-border text-text-secondary hover:border-accent/30'
                    }`}
                  >
                    <input
                      type="radio"
                      name={q.id}
                      value={opt.id}
                      checked={answers[q.id] === opt.id}
                      onChange={() => setAnswers((prev) => ({ ...prev, [q.id]: opt.id }))}
                      className="accent-accent"
                    />
                    {opt.text}
                  </label>
                ))}
              </div>
            </Card>
          ))}

          {result && !result.passed && (
            <p className="text-sm font-medium text-danger">
              You scored {result.score}% — {PARTNER_QUIZ_PASS_PERCENT}% is needed to pass. Review the lessons and try again.
            </p>
          )}

          <Button
            variant="primary"
            disabled={Object.keys(answers).length < PARTNER_QUIZ.length || submittingQuiz}
            onClick={submitQuiz}
          >
            {submittingQuiz ? 'Submitting…' : 'Submit quiz'}
          </Button>
        </div>
      )}
    </PartnerPortalLayout>
  );
}

import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { AlertTriangle, Flame, Zap, Droplet, HelpCircle, Camera, Mic, Loader2, CheckCircle2, PhoneCall } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { fetchPortalBundle, type PortalBundle } from '@/lib/customerPortal';
import {
  HAZARD_OPTIONS,
  STARTED_AT_OPTIONS,
  getImmediateSafetyInstructions,
  hasLifeSafetyHazard,
  uploadEmergencyMedia,
  submitEmergencyTriage,
  type HazardId,
  type EmergencyTriageResult,
} from '@/lib/emergencyTriage';

type Step = 'landing' | 'hazards' | 'details' | 'started' | 'submitting' | 'result';

const HAZARD_ICONS: Record<HazardId, typeof Flame> = {
  gas: Flame,
  smoke: Flame,
  electric: Zap,
  water: Droplet,
  other: HelpCircle,
};

function SafetyBanner({ hazards }: { hazards: HazardId[] }) {
  const lines = getImmediateSafetyInstructions(hazards);
  if (lines.length === 0) return null;
  const lifeSafety = hasLifeSafetyHazard(hazards);
  return (
    <div className={`rounded-2xl border p-4 ${lifeSafety ? 'border-danger/40 bg-danger/5' : 'border-warning-500/40 bg-warning-500/5'}`}>
      <p className={`flex items-center gap-2 text-sm font-semibold ${lifeSafety ? 'text-danger' : 'text-warning-500'}`}>
        <AlertTriangle size={16} />
        Do this right now
      </p>
      <ul className="mt-2 space-y-1.5">
        {lines.map((line) => (
          <li key={line} className="text-sm text-text-primary">
            • {line}
          </li>
        ))}
      </ul>
      {lifeSafety && (
        <p className="mt-3 text-xs font-medium text-danger">If anyone is in danger, call 911 first — do this before finishing this form.</p>
      )}
    </div>
  );
}

export function EmergencyTriagePage() {
  const { token } = useParams<{ token: string }>();
  const [bundle, setBundle] = useState<PortalBundle | null | undefined>(undefined);
  const [step, setStep] = useState<Step>('landing');
  const [hazards, setHazards] = useState<HazardId[]>([]);
  const [whatHappened, setWhatHappened] = useState('');
  const [startedAt, setStartedAt] = useState('');
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [result, setResult] = useState<EmergencyTriageResult | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    fetchPortalBundle(token).then(setBundle);
  }, [token]);

  const toggleHazard = (id: HazardId) => {
    setHazards((prev) => (prev.includes(id) ? prev.filter((h) => h !== id) : [...prev, id]));
  };

  const handleSubmit = async () => {
    if (!token) return;
    setStep('submitting');
    setSubmitError(null);
    try {
      let photoPath: string | null = null;
      let audioPath: string | null = null;
      if (photoFile) photoPath = await uploadEmergencyMedia(token, photoFile, 'photo');
      if (audioFile) audioPath = await uploadEmergencyMedia(token, audioFile, 'audio');

      const res = await submitEmergencyTriage(token, {
        whatHappened,
        hazards,
        startedAt,
        photoPath,
        audioPath,
      });

      if (!res) {
        setSubmitError("We couldn't submit this automatically. Please call us directly instead.");
        setStep('details');
        return;
      }
      setResult(res);
      setStep('result');
    } catch {
      setSubmitError("We couldn't submit this automatically. Please call us directly instead.");
      setStep('details');
    }
  };

  if (bundle === undefined) {
    return (
      <div className="flex min-h-screen flex-col bg-bg-primary">
        <Header />
        <main className="flex flex-1 items-center justify-center px-4 py-12">
          <Loader2 className="animate-spin text-text-secondary" size={24} />
        </main>
        <Footer />
      </div>
    );
  }

  if (bundle === null) {
    return (
      <div className="flex min-h-screen flex-col bg-bg-primary">
        <Header />
        <main className="flex flex-1 items-center justify-center px-4 py-12">
          <div className="max-w-md text-center">
            <p className="text-lg font-semibold text-text-primary">This link isn't available.</p>
            <p className="mt-2 text-sm text-text-secondary">
              If this is a real emergency, please call your service provider directly, or 911 if anyone is in danger.
            </p>
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-bg-primary">
      <Header />
      <main className="flex-1 px-4 py-12">
        <div className="mx-auto w-full max-w-lg">
          {step === 'landing' && (
            <div className="text-center">
              <span className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-danger/10 text-danger">
                <AlertTriangle size={26} />
              </span>
              <h1 className="text-2xl font-bold tracking-tight text-text-primary">Something is wrong?</h1>
              <p className="mt-2 text-sm text-text-secondary">
                Answer a few quick questions and we'll get you safety steps immediately, then get the right technician on the way.
              </p>
              <button
                type="button"
                onClick={() => setStep('hazards')}
                className="focus-ring mt-6 w-full rounded-xl bg-danger px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-danger/90"
              >
                Start emergency report
              </button>
            </div>
          )}

          {step === 'hazards' && (
            <div>
              <h2 className="text-lg font-semibold text-text-primary">What's happening?</h2>
              <p className="mt-1 text-sm text-text-secondary">Select everything that applies.</p>
              <div className="mt-4 grid grid-cols-2 gap-2">
                {HAZARD_OPTIONS.map((h) => {
                  const Icon = HAZARD_ICONS[h.id];
                  const active = hazards.includes(h.id);
                  return (
                    <button
                      key={h.id}
                      type="button"
                      onClick={() => toggleHazard(h.id)}
                      className={`focus-ring flex flex-col items-start gap-2 rounded-2xl border p-4 text-left transition-colors ${
                        active ? 'border-accent bg-accent/5' : 'border-border bg-bg-secondary hover:border-accent/40'
                      }`}
                    >
                      <Icon size={20} className={active ? 'text-accent' : 'text-text-secondary'} />
                      <span className="text-sm font-medium text-text-primary">{h.label}</span>
                    </button>
                  );
                })}
              </div>

              {hazards.length > 0 && (
                <div className="mt-4">
                  <SafetyBanner hazards={hazards} />
                </div>
              )}

              <button
                type="button"
                disabled={hazards.length === 0}
                onClick={() => setStep('details')}
                className="focus-ring mt-6 w-full rounded-xl bg-accent px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-accent/90 disabled:opacity-40"
              >
                Continue
              </button>
            </div>
          )}

          {step === 'details' && (
            <div>
              <h2 className="text-lg font-semibold text-text-primary">Tell us more</h2>
              <SafetyBanner hazards={hazards} />

              {submitError && (
                <p className="mt-3 rounded-xl border border-danger/40 bg-danger/5 px-3 py-2 text-xs text-danger">{submitError}</p>
              )}

              <textarea
                value={whatHappened}
                onChange={(e) => setWhatHappened(e.target.value)}
                rows={4}
                placeholder="What happened? Any details help — what you saw, heard, or smelled."
                className="mt-4 w-full rounded-xl border border-border bg-bg-secondary p-3 text-sm text-text-primary outline-none focus:border-accent"
              />

              <div className="mt-3 grid grid-cols-2 gap-2">
                <label className="focus-ring flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-border bg-bg-secondary px-3 py-2.5 text-xs font-medium text-text-secondary hover:border-accent/40">
                  <Camera size={14} />
                  {photoFile ? 'Photo added' : 'Add a photo'}
                  <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    className="hidden"
                    onChange={(e) => setPhotoFile(e.target.files?.[0] ?? null)}
                  />
                </label>
                <label className="focus-ring flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-border bg-bg-secondary px-3 py-2.5 text-xs font-medium text-text-secondary hover:border-accent/40">
                  <Mic size={14} />
                  {audioFile ? 'Voice note added' : 'Add a voice note'}
                  <input
                    type="file"
                    accept="audio/*"
                    capture
                    className="hidden"
                    onChange={(e) => setAudioFile(e.target.files?.[0] ?? null)}
                  />
                </label>
              </div>

              <button
                type="button"
                onClick={() => setStep('started')}
                className="focus-ring mt-6 w-full rounded-xl bg-accent px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-accent/90"
              >
                Continue
              </button>
            </div>
          )}

          {step === 'started' && (
            <div>
              <h2 className="text-lg font-semibold text-text-primary">When did this start?</h2>
              <div className="mt-4 space-y-2">
                {STARTED_AT_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setStartedAt(opt.id)}
                    className={`focus-ring w-full rounded-xl border px-4 py-3 text-left text-sm font-medium transition-colors ${
                      startedAt === opt.id ? 'border-accent bg-accent/5 text-accent' : 'border-border bg-bg-secondary text-text-primary hover:border-accent/40'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>

              <button
                type="button"
                disabled={!startedAt}
                onClick={handleSubmit}
                className="focus-ring mt-6 w-full rounded-xl bg-danger px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-danger/90 disabled:opacity-40"
              >
                Send emergency report
              </button>
            </div>
          )}

          {step === 'submitting' && (
            <div className="flex flex-col items-center py-16 text-center">
              <Loader2 className="animate-spin text-accent" size={28} />
              <p className="mt-4 text-sm text-text-secondary">Finding the right technician…</p>
            </div>
          )}

          {step === 'result' && result && (
            <div className="text-center">
              <span className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-success-500/10 text-success-500">
                <CheckCircle2 size={26} />
              </span>
              {result.assigned ? (
                <>
                  <h1 className="text-xl font-bold text-text-primary">{result.technicianName ?? 'A technician'} is being dispatched</h1>
                  <p className="mt-2 text-sm text-text-secondary">
                    This was flagged as {result.tier} priority{result.requiredTrade ? ` (${result.requiredTrade})` : ''}. You'll get a call or text shortly with an ETA.
                  </p>
                </>
              ) : (
                <>
                  <h1 className="text-xl font-bold text-text-primary">We've logged this as {result.tier} priority</h1>
                  <p className="mt-2 text-sm text-text-secondary">Our team has been notified and will call you shortly.</p>
                </>
              )}

              <div className="mt-6 text-left">
                <SafetyBanner hazards={hazards} />
              </div>

              <p className="mt-6 flex items-center justify-center gap-2 text-xs text-text-secondary">
                <PhoneCall size={12} />
                If anything gets worse before we call, don't wait — call us or 911.
              </p>
            </div>
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
}

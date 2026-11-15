import { SARAH_SAMPLE_AUDIO } from '@/lib/homeContent';
import { container, eyebrow, h2, lead, panel, sectionY } from './sectionStyles';

/**
 * Plays a recording of a call answered by Sarah.
 * Renders nothing until SARAH_SAMPLE_AUDIO is set in src/lib/homeContent.ts, so no placeholder ever ships.
 * The audio must be a genuine, consented recording (the other party agreed to it being published).
 */
export function SampleCall() {
  const clip = SARAH_SAMPLE_AUDIO;
  if (!clip) return null;

  return (
    <section id="sample-call" aria-labelledby="sample-call-heading" className={`${sectionY} border-t border-border`}>
      <div className={container}>
        <p className={eyebrow}>Sample call</p>
        <h2 id="sample-call-heading" className={h2}>Hear Sarah on a call</h2>
        <p className={lead}>A recording of a call answered by Sarah, our AI receptionist ({clip.durationLabel}).</p>

        <div className={`${panel} mt-8 p-5 sm:p-6`}>
          <audio
            controls
            preload="none"
            src={clip.src}
            className="w-full"
            aria-label="Recording of a call answered by Sarah, an AI receptionist"
          />
          {clip.transcript && clip.transcript.length > 0 && (
            <details className="mt-4">
              <summary className="focus-ring inline-flex min-h-[44px] cursor-pointer items-center text-sm font-semibold text-text-primary">
                Read the transcript
              </summary>
              <ul className="mt-2 space-y-2 text-sm leading-relaxed text-text-secondary">
                {clip.transcript.map((line, i) => (
                  <li key={i}>
                    <strong className="font-semibold text-text-primary">{line.who}:</strong> {line.text}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </div>
    </section>
  );
}

// Recreated: verify against original intent (recovered verbatim from homepage-redesign.patch)
import { CallExample, ForwardingExample, JobExample } from './ExampleUi';
import { container, eyebrow, h2, panel, sectionY } from './sectionStyles';

const STEPS = [
  { title: 'Forward your number', body: 'Keep your number. Point it at Sarah and tell her your services, hours and service area.', visual: <ForwardingExample /> },
  { title: 'Sarah answers', body: 'She greets the caller, asks the right questions, and flags emergencies.', visual: <CallExample /> },
  { title: 'The job lands on your calendar', body: 'She books a slot and texts the customer. You get a summary of the call.', visual: <JobExample /> },
] as const;

export function HowItWorks() {
  return (
    <section id="how-it-works" aria-labelledby="how-heading" className={`${sectionY} border-t border-border`}>
      <div className={container}>
        <p className={eyebrow}>How it works</p>
        <h2 id="how-heading" className={h2}>Live in three steps</h2>
        <ol className="mt-10 grid gap-6 md:grid-cols-3">
          {STEPS.map((s, i) => (
            <li key={s.title} className={`${panel} flex flex-col gap-4 p-5`}>
              <div>
                <p className="font-display text-sm font-semibold text-text-secondary">Step {i + 1}</p>
                <h3 className="mt-1 text-lg font-semibold text-text-primary">{s.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-text-secondary">{s.body}</p>
              </div>
              <div className="mt-auto">{s.visual}</div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

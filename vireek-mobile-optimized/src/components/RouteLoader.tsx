import { useEffect, useState } from 'react';

/**
 * Global route-transition indicator.
 *
 * Deliberately not a logo, wordmark, or a plain spinner — just one
 * abstract kinetic mark: a comet-trail ring (a conic gradient masked
 * into a hairline ring, so the fade reads as motion instead of a hard
 * cut edge) orbiting a small breathing core. It says "something is
 * working" without borrowing any brand furniture, so it's safe to show
 * before we can guarantee the rest of the brand has painted in yet.
 *
 * Pure CSS (no framer-motion) on purpose — this can appear mid
 * route-transition, so it needs to be as cheap and immediate as
 * possible, and it fully respects prefers-reduced-motion.
 */
export function RouteLoader() {
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduceMotion(mq.matches);
    const onChange = () => setReduceMotion(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return (
    <div
      role="status"
      aria-label="Loading"
      className="flex min-h-screen items-center justify-center bg-bg-primary"
    >
      <div className={`vrk-loader${reduceMotion ? ' vrk-loader--still' : ''}`}>
        <span className="vrk-loader__ring" aria-hidden="true" />
        <span className="vrk-loader__core" aria-hidden="true" />
      </div>

      <style>{`
        .vrk-loader {
          position: relative;
          width: 56px;
          height: 56px;
        }

        .vrk-loader__ring {
          position: absolute;
          inset: 0;
          border-radius: 9999px;
          background: conic-gradient(
            from 0deg,
            transparent 0deg,
            rgb(var(--accent-primary) / 0.9) 300deg,
            transparent 360deg
          );
          -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 2.5px), #000 calc(100% - 2.5px));
                  mask: radial-gradient(farthest-side, transparent calc(100% - 2.5px), #000 calc(100% - 2.5px));
          animation: vrk-spin 1.1s linear infinite;
        }

        .vrk-loader__core {
          position: absolute;
          top: 50%;
          left: 50%;
          width: 8px;
          height: 8px;
          margin: -4px 0 0 -4px;
          border-radius: 9999px;
          background: rgb(var(--accent-primary));
          animation: vrk-pulse 1.8s ease-in-out infinite;
        }

        .vrk-loader--still .vrk-loader__ring,
        .vrk-loader--still .vrk-loader__core {
          animation: none;
        }

        @keyframes vrk-spin {
          to { transform: rotate(360deg); }
        }

        @keyframes vrk-pulse {
          0%, 100% {
            transform: scale(0.85);
            box-shadow: 0 0 0 0 rgb(var(--accent-primary) / 0.45);
          }
          50% {
            transform: scale(1.15);
            box-shadow: 0 0 0 10px rgb(var(--accent-primary) / 0);
          }
        }
      `}</style>
    </div>
  );
}

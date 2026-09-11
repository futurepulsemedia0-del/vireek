import { createContext, useContext, useEffect, useRef, ReactNode } from 'react';
import { ExperimentId, getVariant, trackExperimentExposure } from '@/lib/experiments';

interface ExperimentContextValue {
  getVariant: (experimentId: ExperimentId) => string;
}

const ExperimentContext = createContext<ExperimentContextValue | undefined>(undefined);

export function ExperimentProvider({ children }: { children: ReactNode }) {
  return (
    <ExperimentContext.Provider value={{ getVariant }}>
      {children}
    </ExperimentContext.Provider>
  );
}

/**
 * Returns this visitor's sticky variant id for `experimentId` and fires a
 * one-time GA4 exposure event the first time the calling component mounts
 * with that variant. Use this in any landing/pricing component you want
 * to A/B test:
 *
 *   const variant = useExperiment('hero_headline');
 *   return variant === 'variant_b' ? <B /> : <Control />;
 */
export function useExperiment(experimentId: ExperimentId): string {
  const context = useContext(ExperimentContext);
  if (!context) throw new Error('useExperiment must be used within an ExperimentProvider');

  const variant = context.getVariant(experimentId);
  const tracked = useRef(false);

  useEffect(() => {
    if (tracked.current) return;
    tracked.current = true;
    trackExperimentExposure(experimentId, variant);
  }, [experimentId, variant]);

  return variant;
}

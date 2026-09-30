import { useCallback, useEffect, useRef, useState } from 'react';
import type { Job } from '@/lib/supabase';
import {
  buildJobContext,
  gateAssignment,
  predict,
  type AutopilotData,
  type GateResult,
  type Verdict,
} from '@/lib/firstTimeFixAutopilot';
import { DEFAULT_SETTINGS, fetchSettings, loadAutopilotData, type FtfSettings } from '@/lib/firstTimeFixAutopilotApi';

export interface FtfChip {
  probability: number;
  verdict: Verdict;
}

/**
 * Dispatch-board integration. Loads autopilot data once (best-effort: if it
 * fails, dispatch keeps working and the gate simply allows everything).
 */
export function useFirstTimeFixGate(enabled = true) {
  const dataRef = useRef<AutopilotData | null>(null);
  const [settings, setSettings] = useState<FtfSettings>(DEFAULT_SETTINGS);
  const [version, setVersion] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const [data, s] = await Promise.all([loadAutopilotData(), fetchSettings()]);
      dataRef.current = data;
      setSettings(s);
      setVersion((v) => v + 1);
    } catch {
      dataRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, refresh]);

  const chipFor = useCallback(
    (job: Job, technicianId: string): FtfChip | null => {
      const data = dataRef.current;
      if (!data || settings.enforcement === 'off') return null;
      const p = predict(buildJobContext(data, job), technicianId, { threshold: settings.threshold });
      return { probability: p.probability, verdict: p.verdict };
    },
    // `version` re-creates the callback when fresh data arrives so consumers re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settings, version],
  );

  const gate = useCallback(
    (job: Job, technicianId: string): GateResult => {
      const data = dataRef.current;
      if (!data) return { action: 'allow', probability: 0, message: '' };
      const p = predict(buildJobContext(data, job), technicianId, { threshold: settings.threshold });
      return gateAssignment(p, settings.enforcement, settings.threshold);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settings, version],
  );

  return { chipFor, gate, refresh, settings };
}

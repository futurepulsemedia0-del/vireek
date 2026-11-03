import { Bot } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import '@/i18n/agentCallersNamespace';
import { AGENT_CALLERS_NS } from '@/i18n/agentCallersNamespace';
import { Card } from '@/components/ui/Card';
import { callerLines } from '@/lib/agentCallers';

interface Props {
  confidence: number | null;
  platformClaimed: string | null;
  turns: { role: 'caller' | 'agent' | 'unknown'; text: string }[];
}

/** Shown on a call detail page when the caller was classified as an AI agent: attribution + what it asked. */
export function AgentLeadPanel({ confidence, platformClaimed, turns }: Props) {
  const { t } = useTranslation(AGENT_CALLERS_NS);
  const asked = callerLines(turns);
  return (
    <Card interactive={false} className="p-6" role="region" aria-labelledby="agent-lead-title">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 id="agent-lead-title" className="flex items-center gap-2 text-sm font-semibold text-text-primary">
          <Bot size={16} className="text-accent" aria-hidden="true" />
          {t('call.panelTitle')}
          <span className="rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">{t('badge')}</span>
        </h2>
        <Link to="/dashboard/ai-agent-callers" className="focus-ring rounded text-sm font-medium text-accent hover:underline">{t('call.dashboard')}</Link>
      </div>
      <p className="text-sm text-text-secondary">
        {platformClaimed ? t('platformClaimed', { platform: platformClaimed }) : t('platformUnknown')}
        {confidence != null && <> · {t('call.confidence', { pct: Math.round(confidence * 100) })}</>}
      </p>
      <h3 className="mt-4 text-sm font-medium text-text-primary">{t('call.asked')}</h3>
      {asked.length === 0 ? (
        <p className="mt-1 text-sm text-text-secondary">{t('call.askedEmpty')}</p>
      ) : (
        <ol className="mt-2 list-decimal space-y-1.5 ps-5 text-sm text-text-primary">
          {asked.map((line, i) => <li key={i}>{line}</li>)}
        </ol>
      )}
    </Card>
  );
}

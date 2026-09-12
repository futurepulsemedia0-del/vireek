import type { LucideIcon } from 'lucide-react';
import { FileCheck2, CalendarClock, Star } from 'lucide-react';

export type OutboundCampaignType = 'quote_followup' | 'appointment_reminder' | 'review_request_call';

export interface OutboundCampaignConfig {
  type: OutboundCampaignType;
  title: string;
  icon: LucideIcon;
  description: string;
  triggerLabel: string;
  defaultTriggerHours: number;
}

export const OUTBOUND_CAMPAIGNS: OutboundCampaignConfig[] = [
  {
    type: 'quote_followup',
    title: 'Unconverted quote follow-up',
    icon: FileCheck2,
    description:
      'Sarah calls leads stuck at "quoted" who never booked, answers lingering questions, and tries to close the job on the spot.',
    triggerLabel: 'Call back after a quote sits untouched for',
    defaultTriggerHours: 48,
  },
  {
    type: 'appointment_reminder',
    title: 'Appointment reminder calls',
    icon: CalendarClock,
    description:
      'Sarah calls to confirm an upcoming scheduled job, cutting down on no-shows and last-minute cancellations.',
    triggerLabel: 'Call this many hours before the appointment',
    defaultTriggerHours: 24,
  },
  {
    type: 'review_request_call',
    title: 'Review request calls',
    icon: Star,
    description:
      'After a job is completed and paid, Sarah calls to ask for a quick Google review — a live ask converts better than a text alone.',
    triggerLabel: 'Call after the job is completed & paid, after',
    defaultTriggerHours: 3,
  },
];

export function getCampaignConfig(type: OutboundCampaignType): OutboundCampaignConfig {
  const config = OUTBOUND_CAMPAIGNS.find((c) => c.type === type);
  if (!config) throw new Error(`Unknown outbound campaign type: ${type}`);
  return config;
}

export function formatOutboundCallStatus(status: string): string {
  const labels: Record<string, string> = {
    queued: 'Queued',
    calling: 'Calling…',
    connected: 'Connected',
    no_answer: 'No answer',
    voicemail_left: 'Voicemail left',
    converted: 'Converted',
    opted_out: 'Opted out',
    failed: 'Failed',
  };
  return labels[status] ?? status;
}

import type { DqGrade } from '@/lib/dataQuality';

/** Tailwind text colour for a data-health grade (shared by the page and the Overview card). */
export function gradeTone(grade: DqGrade): string {
  if (grade === 'excellent' || grade === 'good') return 'text-success-500';
  if (grade === 'fair') return 'text-warning-500';
  return 'text-danger';
}

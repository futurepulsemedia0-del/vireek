export const OPEN_FEEDBACK_EVENT = 'vireek:open-feedback';
export const OPEN_WHATS_NEW_EVENT = 'vireek:open-whats-new';
export const SURVEY_REQUEST_EVENT = 'vireek:request-survey';

export type FeedbackCategory = 'bug' | 'idea' | 'question' | 'praise' | 'other';
export type SurveyType = 'csat' | 'ces';

export interface SurveyRequest {
  type: SurveyType;
  /** lowercase snake_case, e.g. support_ticket, job_complete, import_wizard, call_review */
  trigger: string;
  /** id of the thing being rated (ticket, job...) - one answer per subject */
  subject?: string;
}

export function openFeedback(category?: FeedbackCategory): void {
  window.dispatchEvent(new CustomEvent(OPEN_FEEDBACK_EVENT, { detail: { category } }));
}
export function openWhatsNew(): void {
  window.dispatchEvent(new Event(OPEN_WHATS_NEW_EVENT));
}
/** Ask for a survey. Fatigue, consent and critical-flow rules decide whether anything is shown. */
export function requestSurvey(req: SurveyRequest): void {
  window.dispatchEvent(new CustomEvent(SURVEY_REQUEST_EVENT, { detail: req }));
}

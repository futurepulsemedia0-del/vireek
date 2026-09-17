// A Postgres EXCLUDE constraint (jobs_no_double_booking — see
// 20260924000000_double_booking_protection.sql) is what actually makes
// double-booking impossible; this file just turns the database error
// that constraint raises (Postgres code 23P01, "exclusion_violation")
// into something worth showing a human, wherever the app writes to
// `jobs.scheduled_datetime` / `jobs.assigned_technician_id`.

interface PostgrestLikeError {
  code?: string;
  message?: string;
}

export const DOUBLE_BOOKING_ERROR_CODE = '23P01';

export function isDoubleBookingError(error: unknown): boolean {
  const e = error as PostgrestLikeError | null | undefined;
  if (!e) return false;
  return e.code === DOUBLE_BOOKING_ERROR_CODE || !!e.message?.includes('jobs_no_double_booking');
}

export const DOUBLE_BOOKING_MESSAGE =
  'That time slot is already booked for this technician — pick a different time or technician.';

import { useMemo } from 'react';
import {
  KIND_LETTERS,
  WEEKDAY_SHORT,
  dayOfWeek,
  findConflicts,
  formatDay,
  technicianLabel,
  unavailability,
  type AvailabilityData,
  type DayCapacity,
  type ScheduledJob,
  type TechnicianLite,
  type Unavailability,
} from '@/lib/timeOff';

interface TimeOffCalendarProps {
  days: string[];
  technicians: TechnicianLite[];
  data: AvailabilityData;
  jobs: ScheduledJob[];
  capacity: Record<string, DayCapacity>;
  today: string;
  onCellClick: (technicianId: string, day: string) => void;
}

function cellLook(u: Unavailability | null): { style: string; letter: string } {
  if (!u) return { style: 'text-transparent hover:bg-accent/10 hover:text-accent', letter: '+' };
  if (u.cause === 'blackout') return { style: 'bg-danger/15 text-danger', letter: 'B' };
  if (u.cause === 'time_off') return { style: 'bg-warning-500/25 text-warning-500', letter: u.kind ? KIND_LETTERS[u.kind] : 'O' };
  return { style: 'bg-bg-tertiary text-text-secondary/60', letter: '–' };
}

export function TimeOffCalendar({ days, technicians, data, jobs, capacity, today, onCellClick }: TimeOffCalendarProps) {
  const conflictKeys = useMemo(() => new Set(findConflicts(jobs, data).map((c) => `${c.technicianId}|${c.day}`)), [jobs, data]);

  return (
    <div>
      <div className="overflow-x-auto rounded-2xl border border-border bg-bg-secondary">
        <table className="w-max min-w-full border-collapse text-xs">
          <caption className="sr-only">Team availability by day. Select a day to add time off for that technician.</caption>
          <thead>
            <tr>
              <th scope="col" className="sticky left-0 z-20 min-w-[132px] bg-bg-secondary px-3 py-2 text-left text-xs font-semibold text-text-secondary">
                Technician
              </th>
              {days.map((day) => (
                <th
                  key={day}
                  scope="col"
                  className={`min-w-[34px] px-0.5 py-2 text-center font-medium ${day === today ? 'text-accent' : 'text-text-secondary'}`}
                >
                  <span className="block text-[10px] uppercase">{WEEKDAY_SHORT[dayOfWeek(day)].slice(0, 2)}</span>
                  <span className="block text-[12px]">{Number(day.slice(8, 10))}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {technicians.map((t) => {
              const name = technicianLabel(t);
              return (
                <tr key={t.id} className="border-t border-border">
                  <th
                    scope="row"
                    className="sticky left-0 z-10 max-w-[160px] truncate bg-bg-secondary px-3 py-0 text-left text-xs font-semibold text-text-primary"
                    title={name}
                  >
                    {name}
                  </th>
                  {days.map((day) => {
                    const u = unavailability(t.id, day, data);
                    const conflict = conflictKeys.has(`${t.id}|${day}`);
                    const { style, letter } = cellLook(u);
                    const label = `${name}, ${formatDay(day, { weekday: 'short', month: 'short', day: 'numeric' })}: ${u ? u.reason : 'available'}${
                      conflict ? '. Has assigned jobs that need reassigning' : ''
                    }`;
                    return (
                      <td key={day} className="p-0.5">
                        <button
                          type="button"
                          onClick={() => onCellClick(t.id, day)}
                          aria-label={label}
                          title={label}
                          className={`focus-ring flex h-9 w-full min-w-[32px] items-center justify-center rounded-md text-[11px] font-bold transition-colors ${style} ${
                            conflict ? 'ring-2 ring-inset ring-danger' : ''
                          }`}
                        >
                          {letter}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            <tr className="border-t-2 border-border">
              <th scope="row" className="sticky left-0 z-10 bg-bg-secondary px-3 py-2 text-left text-xs font-semibold text-text-secondary">
                Open job slots
              </th>
              {days.map((day) => {
                const cap = capacity[day];
                const empty = !cap || cap.open === 0;
                return (
                  <td
                    key={day}
                    className={`px-0.5 py-2 text-center text-[12px] font-semibold ${empty ? 'text-danger' : 'text-text-primary'}`}
                    title={
                      cap
                        ? `${cap.availableTechnicians} of ${cap.totalTechnicians} technicians available · ${cap.booked} booked · ${cap.unassigned} unassigned`
                        : undefined
                    }
                  >
                    {cap ? cap.open : '–'}
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>

      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[11px] text-text-secondary" aria-label="Calendar legend">
        <li className="flex items-center gap-1.5">
          <span className="flex h-4 w-4 items-center justify-center rounded bg-warning-500/25 text-[10px] font-bold text-warning-500">P</span> Time off
          (P PTO, S sick, T training, D personal, O other)
        </li>
        <li className="flex items-center gap-1.5">
          <span className="flex h-4 w-4 items-center justify-center rounded bg-danger/15 text-[10px] font-bold text-danger">B</span> Company blackout
        </li>
        <li className="flex items-center gap-1.5">
          <span className="flex h-4 w-4 items-center justify-center rounded bg-bg-tertiary text-[10px] font-bold text-text-secondary/60">–</span> Not scheduled
        </li>
        <li className="flex items-center gap-1.5">
          <span className="h-4 w-4 rounded ring-2 ring-inset ring-danger" aria-hidden="true" /> Assigned jobs to reassign
        </li>
      </ul>
    </div>
  );
}

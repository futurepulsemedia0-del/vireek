import { DashboardLayout } from '@/components/DashboardNav';
import { InterpreterSettingsCard } from '@/components/interpreter/InterpreterSettingsCard';

export function InterpreterSettingsPage() {
  return (
    <DashboardLayout activeLabel="Live Interpreter">
      <div className="mx-auto max-w-3xl space-y-4 p-4 sm:p-6">
        <header>
          <h1 className="text-xl font-semibold text-text-primary">Live interpreter</h1>
          <p className="mt-1 text-sm text-text-secondary">Callers who speak another language can talk with your team. The AI interpreter always announces itself and reads back addresses, phone numbers, times and prices.</p>
        </header>
        <InterpreterSettingsCard />
      </div>
    </DashboardLayout>
  );
}

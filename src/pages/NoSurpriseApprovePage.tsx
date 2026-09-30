import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { NoSurpriseCustomerPanel } from '@/components/NoSurpriseCustomerPanel';
import type { NoSurpriseRoom } from '@/lib/noSurprise';

export function NoSurpriseApprovePage() {
  const { token } = useParams<{ token: string }>();
  const [room, setRoom] = useState<NoSurpriseRoom | null | undefined>(undefined);

  return (
    <div className="flex min-h-screen flex-col bg-bg-primary">
      <Header />
      <main className="flex-1 px-4 py-12">
        <div className="mx-auto w-full max-w-2xl space-y-5">
          {room && (
            <header>
              <p className="text-xs font-medium text-text-secondary">{room.business_name ?? 'Your service provider'}</p>
              <h1 className="mt-1 text-2xl font-bold text-text-primary">Your price protection</h1>
              <p className="mt-1 text-sm text-text-secondary">
                {room.service_type ?? 'Service'} for {room.customer_name}
                {room.technician_name ? ` · Technician ${room.technician_name}` : ''}
              </p>
            </header>
          )}
          {token ? (
            <NoSurpriseCustomerPanel token={token} standalone onRoomLoaded={setRoom} />
          ) : null}
        </div>
      </main>
      <Footer />
    </div>
  );
}

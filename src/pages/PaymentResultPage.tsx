import { useSearchParams, Link } from 'react-router-dom';
import { CircleCheck, X } from 'lucide-react';

export function PaymentResultPage() {
  const [searchParams] = useSearchParams();
  const success = searchParams.get('status') === 'success';

  return (
    <main className="flex min-h-screen items-center justify-center bg-bg-primary px-6">
      <div className="max-w-sm text-center">
        <div className={`mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full ${success ? 'bg-success/10 text-success' : 'bg-bg-tertiary text-text-secondary'}`}>
          {success ? <CircleCheck className="h-7 w-7" /> : <X className="h-7 w-7" />}
        </div>
        <h1 className="text-xl font-bold text-text-primary">{success ? 'Payment received' : 'Payment canceled'}</h1>
        <p className="mt-2 text-sm text-text-secondary">
          {success ? 'Thank you — your payment was successful. You can close this page.' : 'No charge was made. You can close this page or try the link again.'}
        </p>
        <Link to="/" className="mt-6 inline-block text-sm font-semibold text-accent hover:text-cta">Return to Vireek</Link>
      </div>
    </main>
  );
}

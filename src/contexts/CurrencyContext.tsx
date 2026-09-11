import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { CurrencyCode, CURRENCIES, DEFAULT_CURRENCY, detectCurrencyFromLocale } from '@/lib/currency';

interface CurrencyContextValue {
  currency: CurrencyCode;
  setCurrency: (currency: CurrencyCode) => void;
}

const CurrencyContext = createContext<CurrencyContextValue | undefined>(undefined);

const STORAGE_KEY = 'vireek-currency';

function getInitialCurrency(): CurrencyCode {
  const stored = localStorage.getItem(STORAGE_KEY) as CurrencyCode | null;
  if (stored && CURRENCIES[stored]) return stored;
  return detectCurrencyFromLocale(DEFAULT_CURRENCY);
}

export function CurrencyProvider({ children }: { children: ReactNode }) {
  const [currency, setCurrency] = useState<CurrencyCode>(getInitialCurrency);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, currency);
  }, [currency]);

  return (
    <CurrencyContext.Provider value={{ currency, setCurrency }}>
      {children}
    </CurrencyContext.Provider>
  );
}

export function useCurrency() {
  const context = useContext(CurrencyContext);
  if (!context) throw new Error('useCurrency must be used within a CurrencyProvider');
  return context;
}

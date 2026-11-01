import { createContext, useContext } from 'react';

export interface FormUi {
  formId: string;
  submitting: boolean;
  registerLabel: (name: string, label: string) => void;
  getLabel: (name: string) => string | undefined;
}

export const FormUiContext = createContext<FormUi | null>(null);

export function useFormUi(): FormUi | null {
  return useContext(FormUiContext);
}

export const fieldDomId = (formId: string | undefined, name: string, fallback: string): string =>
  formId ? `${formId}-${name.replace(/[^A-Za-z0-9_-]/g, '-')}` : fallback;

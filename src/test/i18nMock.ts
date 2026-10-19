/** Deterministic react-i18next stand-in for component tests: returns defaultValue with {{vars}} filled in. */
export function interpolate(template: string, vars: Record<string, unknown> = {}): string {
  return template.replace(/{{\s*(\w+)\s*}}/g, (_, key: string) => String(vars[key] ?? ''));
}

const t = (key: string, opts: Record<string, unknown> & { defaultValue?: string } = {}) =>
  interpolate(opts.defaultValue ?? key, opts);
const i18n = { language: 'en', resolvedLanguage: 'en' };

export const reactI18nextMock = {
  useTranslation: () => ({ t, i18n }),
};

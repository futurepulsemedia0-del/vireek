import { useTranslation } from 'react-i18next';

/** One shared line for every surface that shows a Vireek plan price. */
export function TaxExclusiveNote({ className = '' }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <p className={`text-xs text-text-secondary ${className}`.trim()}>
      {t('pricing.taxExclusive', 'Prices exclude VAT/sales tax.')}
    </p>
  );
}

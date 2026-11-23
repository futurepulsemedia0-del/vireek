/* `lifecycle` i18n namespace (deprecation banner). English + Spanish are bundled; other languages fall back to English.
   Spanish strings need native review before release (es is a human-reviewed locale, see locales.config.ts). */
import i18n from '@/i18n';

export const LIFECYCLE_NS = 'lifecycle';

const en = {
  regionLabel: 'Upcoming changes to Vireek',
  headline: '{{title}} is being retired',
  removalDate: 'Planned removal date',
  daysLeft_one: '{{count}} day left',
  daysLeft_other: '{{count}} days left',
  dueToday: 'Last day',
  sunsetPassed: 'The planned removal date has passed. It can be switched off at any time.',
  exportHint: 'Export anything you want to keep before then.',
  exportData: 'Export your data',
  replacement: 'Switch to {{label}}',
  migrationGuide: 'Migration guide',
  dismiss: 'Dismiss the notice about {{title}}',
};

const es = {
  regionLabel: 'Próximos cambios en Vireek',
  headline: '{{title}} dejará de estar disponible',
  removalDate: 'Fecha prevista de retiro',
  daysLeft_one: 'Queda {{count}} día',
  daysLeft_many: 'Quedan {{count}} días',
  daysLeft_other: 'Quedan {{count}} días',
  dueToday: 'Último día',
  sunsetPassed: 'La fecha prevista de retiro ya pasó. Puede desactivarse en cualquier momento.',
  exportHint: 'Exporta lo que quieras conservar antes de esa fecha.',
  exportData: 'Exportar tus datos',
  replacement: 'Cambiar a {{label}}',
  migrationGuide: 'Guía de migración',
  dismiss: 'Descartar el aviso sobre {{title}}',
};

export const LIFECYCLE_RESOURCES = { en, es };

for (const [lng, res] of Object.entries(LIFECYCLE_RESOURCES)) {
  if (!i18n.hasResourceBundle(lng, LIFECYCLE_NS)) i18n.addResourceBundle(lng, LIFECYCLE_NS, res, true, true);
}

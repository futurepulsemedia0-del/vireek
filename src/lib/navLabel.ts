/**
 * Stable translation key for a dashboard nav label.
 * "Parts & Inventory" -> "parts_and_inventory", "My Day (Field)" -> "my_day_field".
 * Keys live in locales/<lng>/dashboard.json under `nav.items.<slug>`; any label
 * without a key falls back to the English label, so adding a nav item never breaks the UI.
 */
export function navSlug(label: string): string {
  return label
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function navLabelKey(label: string): string {
  return `nav.items.${navSlug(label)}`;
}

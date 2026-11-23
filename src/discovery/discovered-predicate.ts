/**
 * Shared SQL predicates for Google-discovered listings. Single source of truth so the public
 * controller and the /stays grid agree on which rows are visible.
 */
export const DISCOVERED_STATE_EXCLUDED = ['ARCHIVED', 'HOST_DECLINED', 'CONVERTED_TO_PROPERTY'];

const prefix = (alias: string) => (alias ? `${alias}.` : '');

/** Discovered, unowned Google rows that are still in play. Dry-run rows never match the literal source. */
export function discoveredOpenSql(alias = 'l'): string {
  const a = prefix(alias);
  const excluded = DISCOVERED_STATE_EXCLUDED.map((s) => `'${s}'`).join(',');
  return `${a}is_discovered = true AND ${a}host_id IS NULL AND ${a}discovery_source = 'google_places' AND COALESCE(${a}discovery_state,'DISCOVERED') NOT IN (${excluded})`;
}

/** Open rows that may appear on the public grid: located, not a duplicate, still in 'discovered' status. */
export function discoveredGridSql(alias = 'l'): string {
  const a = prefix(alias);
  return `${discoveredOpenSql(alias)} AND ${a}status = 'discovered' AND ${a}discovery_duplicate_of IS NULL AND ${a}disc_district IS NOT NULL`;
}

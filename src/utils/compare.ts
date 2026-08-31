/**
 * Deterministic string comparison (UTF-16 code unit order). Used everywhere
 * ordering feeds build artifacts or the DB — localeCompare varies with the
 * machine's locale and breaks reproducible builds.
 */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

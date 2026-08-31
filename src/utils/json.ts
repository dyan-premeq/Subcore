/** JSON.parse-or-[] for array-typed DB columns (targetDefs, changedBy). */
export function parseJsonArray<T>(json: string, map: (value: unknown) => T): T[] {
  try {
    const parsed: unknown = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.map(map) : []
  } catch {
    return []
  }
}

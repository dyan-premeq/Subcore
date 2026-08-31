import type { Database } from 'bun:sqlite'
import { builder } from '../utils/xml-utils'
import { textResponse } from '../utils/mcp-response'
import { getDefDetailsEffective } from '../repositories/defs-repo'

type DefInheritanceMode = 'merged' | 'raw'

type GetDefDetailsResponse = ReturnType<typeof textResponse> & {
  isError?: boolean
}

export function getDefDetailsImpl(
  db: Database,
  defName: string,
  defType?: string,
  inheritance: DefInheritanceMode = 'merged',
) {
  return getDefDetailsEffective(db, defName, defType, inheritance)
}

export function getDefDetails(
  db: Database,
  defName: string,
  defType?: string,
  inheritance: DefInheritanceMode = 'merged',
): GetDefDetailsResponse {
  const rows = getDefDetailsImpl(db, defName, defType, inheritance)

  if (rows.length === 0) {
    const errorText = `Def \`${defName}\`${
      defType ? ` (type: ${defType})` : ''
    } not found. Try using 'search_source' to verify the exact name.`

    return {
      isError: true,
      ...textResponse(errorText),
    }
  }

  const buildedXml = rows.map(row => {
    const type = row.defType
    const obj = JSON.parse(row.payload)

    delete obj.defType

    return builder.build({ [type]: obj })
  })

  return textResponse(buildedXml.join('\n\n'))
}

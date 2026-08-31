import { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { PathSandbox } from './utils/path-sandbox'
import { db } from './utils/db'
import { sourcePath } from './utils/env'
import { searchSource } from './tools/search-source'
import { readFile } from './tools/read-file'
import { listDirectory } from './tools/list-directory'
import { getDefDetails, defDetailsOutputSchema } from './tools/get-def-details'
import { searchDefs, searchDefsOutputSchema } from './tools/search-defs'
import { readCsharpSymbol } from './tools/read-csharp-symbol'
import { listMods } from './tools/list-mods'
import pkg from '../package.json'

const name = 'rimsage'
const version = pkg.version
const sandbox = new PathSandbox('dist/assets')

export function createServer() {
  const server = new McpServer({ name, version })
  registerTools(server)
  return server
}

function registerTools(server: McpServer) {
  // tool: search
  server.registerTool(
    'search_source',
    {
      description: 'Search RimWorld source code using regex.',
      inputSchema: z.object({
        query: z.string().describe('Regex pattern.'),
        file_pattern: z
          .string()
          .optional()
          .describe("Glob filter (e.g. '*.cs', 'Defs/**/*.xml')."),
        case_sensitive: z
          .boolean()
          .default(false)
          .describe('Enforce exact case matching.'),
        scope: z
          .string()
          .optional()
          .describe(
            "Restrict search: 'vanilla' (game Defs + decompiled Source), 'mods' (all imported mods), 'all' (default), or a packageId (e.g. 'mehni.pickupandhaul').",
          ),
        loaded_only: z
          .boolean()
          .default(false)
          .describe(
            'true = only files the game actually loads for the current version (skips old version folders and shadowed files). Default false searches everything.',
          ),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ query, file_pattern, case_sensitive, scope, loaded_only }) =>
      searchSource(sandbox, query, case_sensitive, file_pattern, {
        scope,
        loadedOnly: loaded_only,
      }),
  )

  // tool: read file
  server.registerTool(
    'read_file',
    {
      description: 'Read source file.',
      inputSchema: z.object({
        path: z
          .string()
          .describe(
            'Path (e.g. `Source/RimWorld/AbilityDef.cs`, `Defs/Core/AbilityDefs/AbilityDefs.xml`).',
          ),
        start_line: z
          .number()
          .int()
          .min(0)
          .max(2_000_000)
          .default(0)
          .describe('0-indexed start line.'),
        line_count: z
          .number()
          .int()
          .min(1)
          .max(2_000)
          .default(400)
          .describe('Max lines to return.'),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ path, start_line, line_count }) =>
      readFile(sandbox, path, start_line, line_count),
  )

  // tool: list dir
  server.registerTool(
    'list_directory',
    {
      description: 'List contents of a directory.',
      inputSchema: z.object({
        path: z
          .string()
          .default('')
          .describe('Path (e.g. `Source/Verse`). Empty for root.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .default(100)
          .describe('Max items to return.'),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ path, limit }) => listDirectory(sandbox, path, limit),
  )

  // tool：get def details
  server.registerTool(
    'get_def_details',
    {
      description: 'Get XML of a Def, with its mod override lineage.',
      inputSchema: z.object({
        defName: z.string().describe('Exact defName (e.g. `Gun_Revolver`).'),
        defType: z
          .string()
          .optional()
          .describe('Type filter (e.g. `ThingDef`, `JobDef`).'),
        view: z
          .enum(['merged', 'raw'])
          .default('merged')
          .describe('merged = inheritance-resolved XML, raw = as authored.'),
        mod: z
          .string()
          .optional()
          .describe(
            'packageId filter (e.g. "mehni.pickupandhaul"); with dup="all" reads one specific mod version.',
          ),
        dup: z
          .enum(['effective', 'all'])
          .default('effective')
          .describe(
            'effective = the load-order winner (what the game uses); all = every defining mod\'s version along the override chain.',
          ),
      }),
      outputSchema: defDetailsOutputSchema,
      annotations: { readOnlyHint: true },
    },
    ({ defName, defType, view, mod, dup }) =>
      getDefDetails(db, defName, defType, { view, mod, dup }),
  )

  // tool: search defs
  server.registerTool(
    'search_defs',
    {
      description: 'Search Def indices by partial name or label.',
      inputSchema: z.object({
        query: z.string().describe('Case-insensitive keyword.'),
        defType: z
          .string()
          .optional()
          .describe('Filter by type (e.g. "ThingDef", "JobDef").'),
        mod: z
          .string()
          .optional()
          .describe('Filter by owning mod packageId (e.g. "mehni.pickupandhaul").'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe('Max results to return.'),
        dup: z
          .enum(['effective', 'all'])
          .default('effective')
          .describe(
            'effective = only the load-order winner per def; all = every mod\'s version.',
          ),
      }),
      outputSchema: searchDefsOutputSchema,
      annotations: { readOnlyHint: true },
    },
    ({ query, defType, mod, limit, dup }) =>
      searchDefs(db, query, defType, mod, limit, dup),
  )

  // tool: read csharp symbol
  server.registerTool(
    'read_csharp_symbol',
    {
      description: 'Read a C# type or method definition.',
      inputSchema: z.object({
        typeName: z
          .string()
          .describe('Exact type name (e.g. "ThingDef", "JobDriver").'),
        memberName: z
          .string()
          .optional()
          .describe(
            'Optional method name within the type (e.g. "ExposeData", "ConfigErrors").',
          ),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ typeName, memberName }) =>
      readCsharpSymbol(db, sourcePath, typeName, memberName),
  )

  // tool: list mods
  server.registerTool(
    'list_mods',
    {
      description:
        'List indexed RimWorld mods: load order, packageId, name, source, dependency status and warnings.',
      inputSchema: z.object({
        inProfile: z
          .boolean()
          .optional()
          .describe('true = only mods in the current dev profile.'),
        playerActive: z
          .boolean()
          .optional()
          .describe('true = only mods active in the player game config (diagnostic view).'),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ inProfile, playerActive }) => listMods(db, { inProfile, playerActive }),
  )
}

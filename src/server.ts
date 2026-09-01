import { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { PathSandbox } from './utils/path-sandbox'
import { db } from './utils/db'
import { assetsPath } from './utils/env'
import { searchSource } from './tools/search-source'
import { readFile } from './tools/read-file'
import { listDirectory, listDirectoryOutputSchema } from './tools/list-directory'
import { getDefDetails, defDetailsOutputSchema } from './tools/get-def-details'
import { searchDefs, searchDefsOutputSchema } from './tools/search-defs'
import { readCsharpSymbol } from './tools/read-csharp-symbol'
import { listMods, listModsOutputSchema } from './tools/list-mods'
import { searchPatches, searchPatchesOutputSchema } from './tools/search-patches'
import { searchHarmony, searchHarmonyOutputSchema } from './tools/search-harmony'
import pkg from '../package.json'

const name = 'rimsage'
const version = pkg.version
const sandbox = new PathSandbox('dist/assets')

const instructions = `RimSage indexes a local RimWorld install plus a dev profile of mods. Read-only.

Routing:
- Know the defName -> get_def_details (view=patched for what the game actually
  loads; merged for the inheritance-resolved authoring view)
- Looking for a def -> search_defs (indexed, fast)
- Any other XML/C# text -> search_source (regex, slow, last resort)
- "Who changed this def?" -> search_patches (filters: defName / packageId / opClass)
- "Who hooks this C# method?" -> search_harmony (Harmony patches)
- What is in the profile -> list_mods (overview; detail:true + page for per-mod folders/assets/warnings)

Data boundaries:
- Mod dependencies / loadAfter / incompatibleWith are not indexed. Read the
  mod's About/About.xml with read_file when asked. Dependency PROBLEMS
  (missing, incompatible, cycles, version mismatch) already appear in
  list_mods warnings -- do not re-derive them.
- The patched view is a static evaluation, not the running game; it reports
  unsupported operations. Harmony results marked dynamic are runtime-resolved
  and need reading the mod source.`

export function createServer() {
  const server = new McpServer({ name, version }, { instructions })
  registerTools(server)
  return server
}

function registerTools(server: McpServer) {
  // tool: search
  server.registerTool(
    'search_source',
    {
      title: 'Search RimWorld source',
      description: 'Search RimWorld source code using regex.',
      inputSchema: z.strictObject({
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
            "Valid: 'all' (default), 'vanilla' (Defs + Source), 'mods', or a packageId (e.g. 'mehni.pickupandhaul').",
          ),
        loaded_only: z
          .boolean()
          .default(false)
          .describe(
            'true = only files the game actually loads for the current version (skips old version folders and shadowed files). Default false searches everything.',
          ),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
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
      title: 'Read source file',
      description: 'Read source file.',
      inputSchema: z.strictObject({
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
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ path, start_line, line_count }) =>
      readFile(sandbox, path, start_line, line_count),
  )

  // tool: list dir
  server.registerTool(
    'list_directory',
    {
      title: 'List directory',
      description: 'List contents of a directory.',
      inputSchema: z.strictObject({
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
      outputSchema: listDirectoryOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ path, limit }) => listDirectory(sandbox, path, limit),
  )

  // tool：get def details
  server.registerTool(
    'get_def_details',
    {
      title: 'Get Def details',
      description: 'Get XML of a Def, with its mod override lineage.',
      inputSchema: z.strictObject({
        defName: z.string().describe('Exact defName (e.g. `Gun_Revolver`).'),
        defType: z
          .string()
          .optional()
          .describe('Type filter (e.g. `ThingDef`, `JobDef`).'),
        view: z
          .enum(['merged', 'raw', 'patched'])
          .default('merged')
          .describe(
            'merged = inheritance-resolved XML, raw = as authored, patched = after XML patch evaluation (what the game actually loads; falls back to merged when unavailable).',
          ),
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
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ defName, defType, view, mod, dup }) =>
      getDefDetails(db, defName, defType, { view, mod, dup }),
  )

  // tool: search defs
  server.registerTool(
    'search_defs',
    {
      title: 'Search Defs',
      description: 'Search Def indices by partial name or label.',
      inputSchema: z.strictObject({
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
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ query, defType, mod, limit, dup }) =>
      searchDefs(db, query, defType, mod, limit, dup),
  )

  // tool: read csharp symbol
  server.registerTool(
    'read_csharp_symbol',
    {
      title: 'Read C# symbol',
      description: 'Read a C# type or method definition.',
      inputSchema: z.strictObject({
        typeName: z
          .string()
          .describe(
            'Exact type name (e.g. "ThingDef", "JobDriver"). Namespace-qualified names are accepted and matched by bare type name.',
          ),
        memberName: z
          .string()
          .optional()
          .describe(
            'Optional member (method or field) name within the type (e.g. "ExposeData", "ConfigErrors").',
          ),
        file_path: z
          .string()
          .optional()
          .describe(
            'Exact file pick when the type is defined in several files (vanilla + mods). The multi-hit response lists valid values.',
          ),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ typeName, memberName, file_path }) =>
      readCsharpSymbol(db, assetsPath, typeName, memberName, file_path),
  )

  // tool: list mods
  server.registerTool(
    'list_mods',
    {
      title: 'List indexed mods',
      description:
        'List the mods in the current dev profile. Default = one-line overview per mod; pass detail:true (+page) for folders, assets and full warnings.',
      inputSchema: z.strictObject({
        detail: z
          .boolean()
          .default(false)
          .describe(
            'Two-tier output: false (default) = one-line overview per mod; true = full detail (folders, assets, all warnings) paged 20 per page.',
          ),
        page: z
          .number()
          .int()
          .min(1)
          .default(1)
          .describe('Detail-mode page number (20 mods per page). Only used with detail:true.'),
      }),
      outputSchema: listModsOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ detail, page }) => listMods(db, { detail, page }),
  )

  // tool: search patches
  server.registerTool(
    'search_patches',
    {
      title: 'Search XML patches',
      description:
        'Reverse-lookup XML patch operations: which mod, file and operation patched a def, mod, or op class. The entry point for writing compatibility patches.',
      inputSchema: z.strictObject({
        defName: z
          .string()
          .optional()
          .describe(
            'Find patches targeting this defName (e.g. `Pawn`). Requires patch evaluation (not --skip-patches).',
          ),
        packageId: z
          .string()
          .optional()
          .describe('Filter by patch-owning mod packageId (e.g. `mehni.pickupandhaul`).'),
        opClass: z
          .string()
          .optional()
          .describe(
            'Filter by operation class, case-insensitive (e.g. `PatchOperationReplace`).',
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(50)
          .describe('Max results to return.'),
      }),
      outputSchema: searchPatchesOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ defName, packageId, opClass, limit }) =>
      searchPatches(db, { defName, packageId, opClass, limit }),
  )

  // tool: search harmony patches
  server.registerTool(
    'search_harmony',
    {
      title: 'Search Harmony patches',
      description:
        'Reverse-lookup Harmony patches: which mod and patch class patches a vanilla type or method. Static parse of mod C# sources and decompiled assemblies; runtime-resolved targets appear as dynamic — read the mod source for those.',
      inputSchema: z.strictObject({
        targetType: z
          .string()
          .optional()
          .describe('Exact patched type name (e.g. `Pawn_InventoryTracker`).'),
        targetMethod: z
          .string()
          .optional()
          .describe('Exact patched method name (e.g. `Notify_ItemRemoved`).'),
        mod: z
          .string()
          .optional()
          .describe('Filter by patching mod packageId (e.g. `mehni.pickupandhaul`).'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(50)
          .describe('Max results to return.'),
      }),
      outputSchema: searchHarmonyOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ targetType, targetMethod, mod, limit }) =>
      searchHarmony(db, {
        targetType,
        targetMethod,
        packageId: mod,
        limit,
      }),
  )
}

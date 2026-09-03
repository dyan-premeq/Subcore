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
import { findRefs, findRefsOutputSchema } from './tools/find-refs'
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
- "Who references / uses this def, class or method?" -> find_refs (exhaustive, all layers)
- What is in the profile -> list_mods (overview; detail:true + page for per-mod folders/assets/warnings)
- structuredContent: search_defs/search_patches/search_harmony/find_refs/list_mods/list_directory/get_def_details return it; search_source/read_file/read_csharp_symbol are text-only.

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
      description:
        'LAST RESORT full-text regex grep over every XML and C# file. Slow, and it cannot tell a definition from a mention. Prefer find_refs (who references X), search_defs (locate a def), search_harmony (who patches a C# method), search_patches (who patched a def), get_def_details (read one def). Use this only when none of those can express the query.',
      inputSchema: z.strictObject({
        query: z.string().describe(
          "Regex pattern. A plain identifier (letters/digits/_ only) is matched as a substring via the source index and is fast in any scope; real regex falls back to a full rg scan (slow on scope 'all').",
        ),
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
        limit: z
          .number()
          .int()
          .min(1)
          .max(400)
          .default(400)
          .describe('Max result lines to return; output beyond this is truncated.'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ query, file_pattern, case_sensitive, scope, loaded_only, limit }) =>
      searchSource(db, sandbox, query, case_sensitive, file_pattern, {
        scope,
        loadedOnly: loaded_only,
        limit,
      }),
  )

  // tool: read file
  server.registerTool(
    'read_file',
    {
      title: 'Read source file',
      description:
        'Read one exact file by path, optionally a line range. You need the path already; use search_defs / find_refs / search_source to find it first.',
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
      description:
        'Browse one directory to see what files a mod or namespace ships. To locate content by name, use search_defs or find_refs instead.',
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
      description:
        '"What is inside this def, and which mod overrode it?" Full XML for one exact defName plus its override lineage. Requires the exact defName; use search_defs if you only have a partial name or a label.',
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
      description:
        '"Is there a def named or labelled X?" Fast indexed lookup by partial defName or in-game label. Use when you lack the exact defName; switch to get_def_details once you have it.',
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
      description:
        'Read the source of a known C# type or method by name, without knowing its file path. Resolves across vanilla source and decompiled mod assemblies.',
      inputSchema: z.strictObject({
        symbol: z
          .string()
          .describe(
            "Type name: bare ('FoodUtility'), namespace-qualified ('RimWorld.FoodUtility'), or Type.Member ('QuestUtility.IsQuestLodger' reads just that member).",
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
    ({ symbol, memberName, file_path }) =>
      readCsharpSymbol(db, assetsPath, symbol, memberName, file_path),
  )

  // tool: list mods
  server.registerTool(
    'list_mods',
    {
      title: 'List indexed mods',
      description:
        '"What mods are in this profile, and are any of them broken?" One-line overview per mod by default; detail:true (+page) adds folders, assets and full warnings. Dependency problems (missing, incompatible, cycles, version mismatch) are already reported here.',
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
        packageId: z
          .string()
          .optional()
          .describe(
            'Single-mod lookup: full detail (folders, assets, warnings) for just this mod. Overrides detail/page.',
          ),
      }),
      outputSchema: listModsOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ detail, page, packageId }) => listMods(db, { detail, page, packageId }),
  )

  // tool: search patches
  server.registerTool(
    'search_patches',
    {
      title: 'Search XML patches',
      description:
        '"Which mod changed this def, and how?" Reverse-lookup of XML PatchOperations by target defName, patching mod, or operation class. The entry point for writing compatibility patches.',
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
        '"Which mod hooks, patches or overrides this vanilla C# method?" Reverse-lookup of Harmony patches by target type or method. Never hand-grep for HarmonyPatch attributes, use this. Static parse of mod C# and decompiled assemblies; runtime-resolved targets are marked dynamic and need the mod source read.',
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

  // tool: find refs
  server.registerTool(
    'find_refs',
    {
      title: 'Find all references',
      description:
        'START HERE to trace who uses, spawns, consumes or references something. Exhaustive across ALL layers at once: vanilla Defs and Source, mod XML and decompiled C#, XML patches, Harmony patches. Takes one exact identifier: a defName, C# type, or method name.',
      inputSchema: z.strictObject({
        name: z
          .string()
          .regex(/^[A-Za-z0-9_.]+$/)
          .describe(
            'Exact identifier: a defName, C# type or method name (e.g. `Gun_Revolver`, `StoreUtility`, `Notify_ItemRemoved`).',
          ),
      }),
      outputSchema: findRefsOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ name }) => findRefs(db, sandbox, name),
  )
}

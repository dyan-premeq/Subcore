# Subcore

[![MCP Server](https://badge.mcpx.dev?type=server)](https://modelcontextprotocol.io/introduction) [![bun](https://img.shields.io/badge/Bun-%23000000.svg?style=flat&logo=bun)](https://bun.com/) [![ripgrep](https://img.shields.io/badge/ripgrep-%23000000.svg?style=flat&logo=rust)](https://github.com/BurntSushi/ripgrep)

English | [简体中文](./README_zh.md)

Subcore is a Model Context Protocol (MCP) server for RimWorld mod development and modded codebase analysis. It is an enhanced fork of [**realloon/RimSage**](https://github.com/realloon/RimSage), rebuilt for **modded environments**.

Subcore reconstructs RimWorld's mod loading pipeline—resolving `LoadFolders.xml`, evaluating XML `PatchOperation` rules in load order before `XmlInheritance`, indexing decompiled C# assemblies and Harmony hooks, and exposing fast, cross-layer lookups to AI agents over MCP.

---

## Quick Start

### 1. Prerequisites

- [Bun](https://bun.com/) (bundled with SQLite 3.43+ and [FTS5 contentless-delete](https://www.sqlite.org/fts5.html#contentless_delete_tables) support)
- [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg` on `PATH`)
- Optional, for C# assembly decompilation: [ilspycmd](https://github.com/icsharpcode/ILSpy)
  ```sh
  dotnet tool install -g ilspycmd
  ```

### 2. Install

```sh
bun install
```

### 3. Run Your First Sync

On the first sync, pass the directory containing RimWorld's `Version.txt`. Subcore remembers this path for future runs (or you can set `SUBCORE_GAME_ROOT`).

- **Start from your current RimWorld mod list** (snapshots `ModsConfig.xml` into `subcore.profile.json` and indexes it):
  ```sh
  bun run sync "/path/to/RimWorld" --from-game-config
  ```
- **Or use a hand-curated development profile** (edit `subcore.profile.json`, then sync; if the file is missing, Subcore falls back to vanilla-only):
  ```sh
  bun run sync "/path/to/RimWorld"
  ```

> Decompiling RimWorld for mod development is permitted under the [RimWorld EULA](https://rimworldgame.com/eula).

---

## Profiles & Syncing

Subcore deliberately separates your **development profile** from the game's live **`ModsConfig.xml`**:

| Source                                                                                 | Role                                                                | Used by default?                                                                           |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `subcore.profile.json` (or `SUBCORE_PROFILE` / `--profile`)                            | **Single source of truth** for what Subcore imports and indexes     | **Yes** (`bun run sync`, MCP `sync_profile`)                                               |
| RimWorld `ModsConfig.xml` (auto-discovered or `SUBCORE_MODS_CONFIG` / `--mods-config`) | Optional snapshot source of the player's currently enabled mod list | **No** — only read when you explicitly pass `--from-game-config` or `fromGameConfig: true` |

Why? When developing a mod, your curated test profile should stay stable even if you change mods for a personal playthrough. Ordinary sync refreshes files and indexes for the **configured development profile** (picking up edits to `subcore.profile.json`, local mod changes, Steam Workshop updates, or RimWorld version updates) without touching it from `ModsConfig.xml`.

### Common Sync Commands

```sh
# Incremental sync of the current development profile (fast no-op when unchanged)
bun run sync

# Overwrite subcore.profile.json with RimWorld's active ModsConfig.xml, then sync
bun run sync --from-game-config

# Force a full re-import and rebuild of all indexes even when inputs are unchanged
bun run sync --full

# Override input paths for a single run
bun run sync "/path/to/RimWorld" \
  --profile ./my.profile.json \
  --mods-config "/path/to/ModsConfig.xml" \
  --workshop-root "/path/to/workshop/content/294100"
```

`bun run sync` prints a JSON summary reporting `status` (`"up-to-date"` or `"synced"`), `mode` (`"unchanged"`, `"incremental"`, or `"full"`), `changedMods`, `removedMods`, `xmlRebuilt`, and `elapsedMs`. Older SQLite schema versions are rebuilt automatically on the first sync.

Individual stage scripts (`import:vanilla`, `import:mods`, `clean`, `index:mods`, `index:defs`, `index:patches`, `index:csharp`, `index:source`, `build`) remain available for single-stage workflows.

### Profile Format (`subcore.profile.json`)

```jsonc
{
  "name": "my-mod-project",
  "gameVersion": "1.7", // Optional: warns if major.minor differs from installed RimWorld
  "base": "all-dlc", // "all-dlc" | "core-only"
  "mods": [
    "brrainz.harmony",
    "oskarpotocki.vanillafactionsexpanded.core",
    "mehni.pickupandhaul"
  ],
  "autoOrder": true // true = topological sort by About.xml rules; false = preserve array order
}
```

When generated via `--from-game-config`, Subcore sets `autoOrder: false` to preserve your exact in-game load order (and switches `base` to `"core-only"` with explicit DLC entries if only a subset of installed DLCs is active).

### Environment Variables

| Variable                | Purpose                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------- |
| `SUBCORE_GAME_ROOT`     | RimWorld installation directory (overrides the remembered path)                         |
| `SUBCORE_WORKSHOP_ROOT` | Steam Workshop `294100` folder (auto-discovered beside the game root by default)        |
| `SUBCORE_MODS_CONFIG`   | Path to `ModsConfig.xml` (used only with `--from-game-config` / `fromGameConfig: true`) |
| `SUBCORE_PROFILE`       | Alternate profile JSON path (defaults to `<repo>/subcore.profile.json`)                 |
| `PORT`                  | Listening port for `bun run start:http` (defaults to `3000`)                            |

CLI flags take precedence over environment variables.

---

## Connect to MCP Clients

Subcore embeds built-in MCP server `instructions` and tool schemas so compliant MCP hosts automatically give the model tool-routing and verification guidance.

### Stdio Transport (Claude Code, Cursor, Claude Desktop, Antigravity, etc.)

Add Subcore to your client's MCP configuration (e.g. `.cursor/mcp.json` or `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "subcore": {
      "command": "bun",
      "args": ["run", "/path/to/Subcore/src/stdio.ts"]
    }
  }
}
```

### Streamable HTTP Transport

Start the local HTTP server:

```sh
bun run start:http
# Exposes /mcp (Streamable HTTP) and /health
```

Then point your client at the local endpoint:

```json
{
  "mcpServers": {
    "subcore": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

---

## MCP Tools

Subcore exposes **10 read-only query tools** and **1 explicit sync tool**.

### Cross-Layer Reference Tracing

- **`find_refs`** — Exhaustive reference lookup across all layers at once: vanilla Defs and C# source, mod XML, decompiled mod assemblies, XML patches, and Harmony hooks. Takes one exact identifier (`defName`, C# type, or method).

### Def Inspection & Discovery

- **`get_def_details`** — Full XML and override lineage for one exact `defName`.
  - `view="merged"` *(default)*: Inheritance-resolved XML without patches.
  - `view="patched"`: Runtime-evaluated XML after load-order patches and inheritance.
  - `view="raw"`: Authored XML as written in source.
  - `dup="effective"` *(default)* returns the load-order winner; `dup="all"` returns every defining mod's version.
- **`search_defs`** — Fast indexed search by partial `defName` or in-game label (or omit `query` to enumerate defs), with `defType`, `mod`, and `dup` filters.

### Patch & Hook Reverse-Lookup

- **`search_patches`** — Reverse lookup of XML `PatchOperation` rules by target `defName`, patching mod (`packageId`), or operation class (e.g. `PatchOperationReplace`).
- **`search_harmony`** — Reverse lookup of Harmony patches by `targetType`, `targetMethod`, or patching `mod`. Static analysis of mod C# and decompiled assemblies; runtime-resolved targets are marked `dynamic`.

### C# & Source Navigation

- **`read_csharp_symbol`** — Read a C# class, method, or field without knowing its file path (`FoodUtility`, `RimWorld.FoodUtility`, `QuestUtility.IsQuestLodger`, or explicit `memberName`). Resolves across vanilla code and decompiled mod assemblies.
- **`search_source`** — Search across all XML and C# files with `scope` (`all`, `vanilla`, `mods`, or a `packageId`), `file_pattern`, and `loaded_only` filters. Plain identifiers use the FTS5 index; full regex falls back to `ripgrep`.
- **`read_file`** — Read a specific file inside the asset sandbox by relative path and line range.
- **`list_directory`** — Browse directories inside the asset sandbox.

### Profile & Index Management

- **`list_mods`** — Overview of active mods in the profile, load order, and dependency/compatibility warnings (`detail: true` + `page` or `packageId` for per-mod folders and asset counts).
- **`sync_profile`** — Refresh imported assets and the SQLite index for the configured development profile.
  - `fromGameConfig` *(default `false`)*: Set `true` **only** when you explicitly want to replace the development profile with a snapshot of `ModsConfig.xml` before syncing.
  - `full` *(default `false`)*: Force a fresh re-import and rebuild of all layers.
  - `gameRoot` *(optional)*: Override `SUBCORE_GAME_ROOT` / remembered installation path.

---

## How It Works

### Incremental Sync

1. **Two-level input fingerprinting**: Sync hashes the game version, ordered development profile, metadata, and content directories (`About/`, `Defs/`, `Patches/`, `Source/`, `Assemblies/`, `Languages/`, `LoadFolders.xml` — skipping heavy binary assets like `Textures/` and `Sounds/`).
2. **Windows NTFS USN fast path**: On Windows, when an accessible NTFS change journal is available, unchanged syncs verify in tens of milliseconds across separate CLI/MCP runs; if the journal is unavailable or its cursor rolled over, sync falls back automatically to a content scan.
3. **Three-tier incremental updates**:
   - Per-mod asset staging and DLL-hash-cached decompilation.
   - Per-mod SQLite updates for `mods`, `csharp_index`, `harmony_patches`, and `source_fts` (`contentless_delete=1`). Pure load-order reordering preserves unchanged C#/Harmony/FTS rows.
   - Globally accurate XML evaluation (`defs` + `patches`) runs only when XML-contributing packages change content or order, a `LoadFolders.xml` selection switches, or a tracked `MayRequire` / `MayRequireAnyOf` / `PatchOperationFindMod` predicate changes outcome.
4. **Live-reader safe publishing**: Changed files are staged and SQLite updates are committed in a single WAL transaction so connected read-only MCP clients continue querying without interruption.

### RimWorld Pipeline Fidelity

1. **Load-Order Accurate**: Supports topological sorting from `About.xml` rules (`autoOrder: true`) or exact player order (`autoOrder: false`).
2. **Patch Before Inheritance**: Faithful to RimWorld's `LoadedModManager`, XML `PatchOperation` rules run on the raw unified Def tree before `XmlInheritance` resolves abstract parents and templates.
3. **Lineage Tracking**: Every Def records its provenance (`defined by ... -> overridden by ... -> effective: ...`).

---

## Development & Tests

```sh
# Type-check
bun run type-check

# Run test suite
bun test

# Validate XML patch evaluation against the current index
bun run regression:patches

# Scan all patch XML files in the Steam Workshop folder
bun run regression:patches --workshop
```

## Disclaimer

Subcore is intended for RimWorld mod development, compatibility work, and debugging.

While decompiling RimWorld's own assemblies for mod development is permitted under the [RimWorld EULA](https://rimworldgame.com/eula), third-party mods are subject to their respective authors' licenses and terms. **Do not use Subcore to reverse-engineer, decompile, or extract code or assets from mods whose authors have chosen closed-source protection.**

You are solely responsible for how you use this tool. The author of Subcore assumes no responsibility or liability for any disputes, claims, or legal consequences arising from its misuse.

## License

Subcore is licensed under the [GNU General Public License v3.0](./LICENSE) (`GPL-3.0-only`).

Portions of this project are derived from [**realloon/RimSage**](https://github.com/realloon/RimSage) (MIT License); the original copyright and license notice are preserved in [THIRD_PARTY_LICENSES.md](./THIRD_PARTY_LICENSES.md).

# RimSage

[![MCP Server](https://badge.mcpx.dev?type=server)](https://modelcontextprotocol.io/introduction) [![bun](https://img.shields.io/badge/Bun-%23000000.svg?style=flat&logo=bun)](https://bun.com/) [![ripgrep](https://img.shields.io/badge/ripgrep-%23000000.svg?style=flat&logo=rust)](https://github.com/BurntSushi/ripgrep)

An MCP server that provides RimWorld source code search and browsing capabilities.

## Available Tools

The server provides these tools:

- `search_source` - Search RimWorld source code
- `read_file` - Read specific files
- `list_directory` - List directory contents
- `search_defs` - Search through RimWorld Defs
- `get_def_details` - Get raw or merged RimWorld Def XML
- `read_csharp_symbol` - Read a C# type or method definition

## Quick Start

The easiest way to use RimSage is through the online service:

```
https://mcp.rimsage.com/mcp
```

You can find the integration methods for different Agent clients in the [wiki](https://github.com/realloon/RimSage/wiki).

## Self-Hosted

RimSage also supports stdio transport for local deployment.

1. Install dependencies

- [bun](https://bun.com/)
- [ripgrep](https://github.com/BurntSushi/ripgrep)

2. Clone the repository

```sh
git clone https://github.com/realloon/RimSage.git
```

3. Install package dependencies

```sh
bun install
```

4. Build index

```sh
bun run src/scripts/import-defs /path/to/your/rimworld/root/path
bun run src/scripts/import-csharp /path/to/decompiled/source/root/path
bun run build
```

You'll need local RimWorld files and a decompiled C# project, which is allowed under the [RimWorld EULA](https://rimworldgame.com/eula).

5. Add this MCP server

You can find the integration methods for different Agent clients in the [wiki](https://github.com/realloon/RimSage/wiki).

Most Agent clients support `mcp.json` configuration:

```json
{
  "mcpServers": {
    "rimsage": {
      "command": "bun",
      "args": ["run", "/path/to/this/repo"]
    }
  }
}
```

**Replace** `/path/to/this/repo` with the actual path to this repository on your system.

## Modded Environment Development

RimSage can index mods on top of the vanilla game. 

The dev-time mod set is declared in a **profile** (`rimsage.profile.json`), which is independent from the player's load order.

1. Snapshot (or hand-write) a profile

```sh
# draft from the player's ModsConfig.xml (then trim it)
bun run import:mods /path/to/game --from-game-config --out rimsage.profile.json
```

```jsonc
// rimsage.profile.json
{
  "name": "my-compat-project",
  "base": "all-dlc",           // 'core-only' | 'all-dlc'
  "mods": [
    "brrainz.harmony",
    "oskarpotocki.vanillafactionsexpanded.core",
    "mehni.pickupandhaul"
  ],
  "autoOrder": true            // topological sort by dependencies; false = keep array order
}
```

2. Import mods into `dist/assets/Mods` (full structure, incl. version folders; `Textures`/`Sounds` are skipped).  Also produces `dist/mods-manifest.json` with load order + effective file sets.

```sh
bun run import:mods /path/to/game            # RIMSAGE_GAME_ROOT also works
bun run import:mods /path/to/game --full     # force re-copy
```

3. Build and use

```sh
bun run build
```

New/changed tools: `list_mods`, `search_source` with `scope` ('vanilla' | 'mods' | 'all' | packageId) and `loaded_only`, `search_defs` with `mod` filter and `dup` ('effective' = load-order winner only, default; 'all' = every mod version), `get_def_details` with `view` ('merged' | 'raw'), `dup` and `mod` params plus a **Lineage** header (`defined by … → overridden by … → effective: …`) on every result.

Def semantics follow the game's `XmlInheritance` for the current game version: parent selection by load order, missing parents / cycles degrade instead of failing the build, `MayRequire` / `MayRequireAnyOf` defs are skipped unless the referenced packageId is in the profile (case-insensitive, `|postfix` ignored). The `@Name` inheritance registry is queryable in `dist/index.db` (`def_names` table, one row per `@Name` registration per mod).

## Development

```sh
bun run start # stdio
bun run start:http # Streamable HTTP
bun test       # unit tests (fixtures under test/fixtures)
```

# Subcore

[![MCP Server](https://badge.mcpx.dev?type=server)](https://modelcontextprotocol.io/introduction) [![bun](https://img.shields.io/badge/Bun-%23000000.svg?style=flat&logo=bun)](https://bun.com/) [![ripgrep](https://img.shields.io/badge/ripgrep-%23000000.svg?style=flat&logo=rust)](https://github.com/BurntSushi/ripgrep)

Subcore is a Model Context Protocol (MCP) server for RimWorld mod development and codebase analysis. The project is an enhanced fork of [**realloon/RimSage**](https://github.com/realloon/RimSage),  overhauled specifically for **modded environments**. 

Subcore reconstructs RimWorld's mod loading pipeline—evaluating XML `PatchOperation` rules in load order, resolving cross-mod `XmlInheritance`, indexing decompiled C# assemblies and Harmony patches, and providing exhaustive cross-layer reference lookups for AI agents.

---

## MCP Tools

Subcore provides 10 tools tailored for AI agent workflows:

### Cross-Layer Reference Tracing

- **`find_refs`** — Exhaustive reference lookup across all layers simultaneously: vanilla Defs, C# source, mod XML, decompiled mod assemblies, XML patches, and Harmony hooks. Takes a single identifier (`defName`, C# type, or method).

### Def Inspection & Discovery

- **`get_def_details`** — Inspect full XML for a specific `defName` along with its override lineage.
  - `view="patched"`: Game runtime truth after XML patches and inheritance resolution.
  - `view="merged"`: Inheritance-resolved XML without patches.
  - `view="raw"`: Authored XML as written in source.
- **`search_defs`** — Fast indexed search by partial `defName` or in-game label. Supports `defType` and `mod` filters.

### Patch & Hook Reverse-Lookup

- **`search_patches`** — Reverse lookup of XML `PatchOperation` rules by target `defName`, patching mod (`packageId`), or operation class (e.g. `PatchOperationReplace`).
- **`search_harmony`** — Reverse lookup of Harmony patches by target C# class (`targetType`) or method (`targetMethod`). Static analysis of mod C# and assemblies.

### C# Source Navigation

- **`read_csharp_symbol`** — Read the source code of a C# class, method, or field by name without needing its file path. Resolves across vanilla code and decompiled mod assemblies.
- **`search_source`** — Regex search with FTS identifier pre-filtering across all source files and Defs. Supports scope (`all`, `vanilla`, `mods`, or a specific `packageId`) and `loaded_only` filters.

### Workspace & Profile

- **`list_mods`** — Overview of active mods in the profile, load order, asset counts, and dependency/compatibility warnings.
- **`read_file`** — Read a specific file by relative path with optional line offsets.
- **`list_directory`** — Browse directory contents within the asset sandbox.

---

## Setup & Usage

### 1. Prerequisites

- [Bun](https://bun.com/) (v1.0+)

- [ripgrep](https://github.com/BurntSushi/ripgrep)

- *(Optional, for mod assembly decompilation)* [ilspycmd](https://github.com/icsharpcode/ILSpy):
  
  ```sh
  dotnet tool install -g ilspycmd
  ```

### 2. Install

Clone the repository, then in `Subcore/` folder, run:

```sh
bun install
```

### 3. Import Vanilla Assets

Extract Defs and C# source from your local game installation and decompiled source:

```sh
bun run src/scripts/import-defs.ts /path/to/RimWorld
bun run src/scripts/import-csharp.ts /path/to/DecompiledSource
```

*(Decompiling RimWorld for mod development is permitted under the [RimWorld EULA](https://rimworldgame.com/eula).)*

### 4. Configure & Import Mods

The program uses a decoupled **profile** (`rimsage.profile.json`) to define which mods to index, independent of your player save state.

Generate a profile from your game's active mod list:

```sh
bun run import:mods /path/to/RimWorld --from-game-config --out rimsage.profile.json
```

Or write `rimsage.profile.json` manually:

```jsonc
{
  "name": "my-mod-project",
  "base": "all-dlc", // "core-only" | "all-dlc"
  "mods": [
    "brrainz.harmony",
    "oskarpotocki.vanillafactionsexpanded.core",
    "mehni.pickupandhaul"
  ],
  "autoOrder": true // Topological sort by dependencies
}
```

Import mod assets and decompile their assemblies:

```sh
bun run import:mods /path/to/RimWorld
```

### 5. Build Database Index

Build the SQLite index and patch cache:

```sh
bun run build
```

### 6. Connect to Agent Clients

#### Stdio Transport (Cursor, Claude Desktop, Antigravity, etc.)

Add to your client's MCP settings (e.g. `.cursor/mcp.json` or `claude_desktop_config.json`):

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

#### Streamable HTTP Transport

Alternatively, start the local HTTP server:

```sh
bun run start:http
# Listening on http://localhost:3000/mcp
```

And configure your client with the local URL:

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

## How It Works

1. **Load-Order Accurate**: Mods and DLCs are topologically sorted according to `About.xml` dependencies and RimWorld's load rules.
2. **Patch Before Inheritance**: Faithful to RimWorld's `LoadedModManager`, XML `PatchOperation` modifications run against the raw unified Def tree before `XmlInheritance` resolves templates and abstract parents.
3. **Lineage Tracking**: Every Def retains provenance (`defined by ... -> overridden by ... -> effective: ...`), showing exact override origins.
4. **Zero Hallucination Routing**: Built-in instructions guide AI models to check indexed ground truth (`find_refs`, `get_def_details`, `search_harmony`) rather than guessing class structures or brute-force searching text.

---

## Development & Tests

```sh
# Run unit test suite
bun test

# Validate patch evaluation against index
bun run regression:patches

# Scan all patch XML files in workshop folder
bun run regression:patches --workshop
```

## License

MIT

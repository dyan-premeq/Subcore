# Subcore

[![MCP Server](https://badge.mcpx.dev?type=server)](https://modelcontextprotocol.io/introduction) [![bun](https://img.shields.io/badge/Bun-%23000000.svg?style=flat&logo=bun)](https://bun.com/) [![ripgrep](https://img.shields.io/badge/ripgrep-%23000000.svg?style=flat&logo=rust)](https://github.com/BurntSushi/ripgrep)

[English](./README.md) | 简体中文

Subcore 是一个给 RimWorld Mod 开发用的 MCP Server，基于 [**realloon/RimSage**](https://github.com/realloon/RimSage) 改写，重点适配了装有大量 Mod 的环境。

它会在本地还原 RimWorld 的加载流程——解析 `LoadFolders.xml`、按加载顺序跑完 XML `PatchOperation` 再做 `XmlInheritance` 继承、反编译并索引 C# 程序集和 Harmony 补丁。接上 AI 编程助手后，模型可以直接查“游戏里最终生效的 Def 和代码是什么”，不用靠猜，也不用对着几万个文件盲搜。

---

## 快速开始

### 1. 环境准备

- [Bun](https://bun.com/)（内置 SQLite 3.43+，需要支持 [FTS5 contentless-delete](https://www.sqlite.org/fts5.html#contentless_delete_tables)）
- [ripgrep](https://github.com/BurntSushi/ripgrep)（确保 `rg` 在 `PATH` 中）
- 反编译 DLL 用（可选但建议装）：[ilspycmd](https://github.com/icsharpcode/ILSpy)
  ```sh
  dotnet tool install -g ilspycmd
  ```

### 2. 安装依赖

```sh
bun install
```

### 3. 第一次同步

第一次运行需要传入包含 RimWorld `Version.txt` 的游戏根目录。跑过一次后 Subcore 会记住这个路径，后续不用再传（也可以通过环境变量 `SUBCORE_GAME_ROOT` 覆盖）。

- **直接照搬你游戏里当前启用的 Mod 列表**（读取 `ModsConfig.xml` 写入 `subcore.profile.json` 并建索引）：
  ```sh
  bun run sync "/path/to/RimWorld" --from-game-config
  ```
- **或者自己维护开发列表**（先写好 `subcore.profile.json` 再运行；如果文件不存在，会按纯原版 + 全 DLC 索引）：
  ```sh
  bun run sync "/path/to/RimWorld"
  ```

> 根据 [RimWorld EULA](https://rimworldgame.com/eula)，为开发 Mod 反编译游戏代码是允许的。

---

## Profile 与同步机制

Subcore 刻意把**开发用 Mod 列表（Profile）**和**游戏里的 `ModsConfig.xml`** 分开了：

| 来源 | 用途 | 默认会读吗？ |
| --- | --- | --- |
| `subcore.profile.json`（可用 `SUBCORE_PROFILE` 或 `--profile` 指定） | Subcore 导入和建索引的**唯一默认依据** | **会**（`bun run sync` 和 MCP `sync_profile` 默认都读它） |
| RimWorld 的 `ModsConfig.xml`（自动探测，也可用 `SUBCORE_MODS_CONFIG` / `--mods-config` 指定） | 玩家当前在游戏里启用的 Mod 列表 | **不会**——只有显式传 `--from-game-config` 或 `fromGameConfig: true` 时才会读取 |

这样设计的原因很简单：写 Mod 时通常只想固定测几个依赖 Mod，不想自己换个几百 Mod 的日常档玩一局，回头把开发索引全冲掉。所以平时直接跑 `bun run sync`，只会按现有的 `subcore.profile.json` 检查文件变化（包括修改 profile、本地 Mod 改动、创意工坊更新、游戏本体更新）并做增量同步，**不会**去读 `ModsConfig.xml`。

当你确实想把游戏里当前的 Mod 列表同步过来时，再显式加上 `--from-game-config`。

### 常用同步命令

```sh
# 按当前开发 profile 做增量同步（没改动时很快就会跳过）
bun run sync

# 用游戏当前的 ModsConfig.xml 覆盖 subcore.profile.json，然后同步
bun run sync --from-game-config

# 强制全量重新导入并重建所有索引
bun run sync --full

# 单次运行临时指定路径
bun run sync "/path/to/RimWorld" \
  --profile ./my.profile.json \
  --mods-config "/path/to/ModsConfig.xml" \
  --workshop-root "/path/to/workshop/content/294100"
```

同步结束后会输出一段 JSON，告诉你这次是 `"up-to-date"` 还是 `"synced"`、走了 `"unchanged"` / `"incremental"` / `"full"` 哪种模式、哪些 Mod 变动或移除了、有没有重算 XML，以及耗时。遇到旧版数据库结构时，第一次同步会自动重建。

如果只想单独跑某个步骤，原来的 `import:vanilla`、`import:mods`、`clean`、`index:*` 和 `build` 脚本也都保留着。

### `subcore.profile.json` 格式

```jsonc
{
  "name": "my-mod-project",
  "gameVersion": "1.6", // 可选：主次版本和当前游戏不一致时会给出警告
  "base": "all-dlc", // "all-dlc" | "core-only"
  "mods": [
    "brrainz.harmony",
    "oskarpotocki.vanillafactionsexpanded.core",
    "mehni.pickupandhaul"
  ],
  "autoOrder": true // true = 按 About.xml 依赖关系自动排序；false = 严格按数组顺序
}
```

用 `--from-game-config` 生成时，Subcore 会把 `autoOrder` 设为 `false`，原样保留你在游戏里的排序；如果已安装的 DLC 里只启用了一部分，`base` 会切成 `"core-only"` 并把启用的 DLC 显式列进 `mods`。

### 环境变量

| 变量名 | 说明 |
| --- | --- |
| `SUBCORE_GAME_ROOT` | RimWorld 安装目录（优先级高于上次记住的路径） |
| `SUBCORE_WORKSHOP_ROOT` | Steam 创意工坊 `294100` 目录（默认会顺着游戏目录自动找） |
| `SUBCORE_MODS_CONFIG` | `ModsConfig.xml` 路径（仅在传 `--from-game-config` / `fromGameConfig: true` 时生效） |
| `SUBCORE_PROFILE` | 换用其他 profile JSON 文件（默认 `<仓库根目录>/subcore.profile.json`） |
| `PORT` | `bun run start:http` 的监听端口（默认 `3000`） |

命令行参数的优先级高于环境变量。

---

## 接入 AI 客户端

Subcore 内置了 MCP server `instructions` 和各工具的参数说明，支持 MCP 的客户端连上之后会自动告诉模型该怎么选工具、怎么核对代码，一般不需要自己手写提示词。

### Stdio 模式（Claude Code、Cursor、Claude Desktop、Antigravity 等）

在客户端的 MCP 配置文件（如 `.cursor/mcp.json`、`claude_desktop_config.json`）里加上：

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

### Streamable HTTP 模式

先在本地把 HTTP 服务起起来：

```sh
bun run start:http
# 提供 /mcp（Streamable HTTP）和 /health 接口
```

然后把客户端指向这个地址：

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

## MCP 工具列表

一共提供 **10 个只读查询工具**和 **1 个同步工具**。

### 跨层反查引用

- **`find_refs`** — 给一个精确标识符（`defName`、C# 类名或方法名），一次性把原版 Def、原版 C#、Mod XML、反编译后的 Mod C#、XML Patch 和 Harmony 补丁里所有引用它的地方都翻出来。

### 查 Def

- **`get_def_details`** — 按精确 `defName` 看完整 XML 和覆盖来源链：
  - `view="merged"`（默认）：只做 `XmlInheritance` 继承展开，不含 Patch。
  - `view="patched"`：按加载顺序跑完 Patch 和继承后的最终 XML，最接近游戏实际加载结果。
  - `view="raw"`：源文件里原本写的内容。
  - `dup="effective"`（默认）只看最终生效的那份；`dup="all"` 可以看同名 Def 在各个 Mod 里的所有定义。
- **`search_defs`** — 按部分 `defName` 或游戏内 `label` 快速搜 Def；也可以留空 `query`，配合 `defType` / `mod` 列出某个 Mod 定义了哪些 Def。

### 查 Patch 和 Harmony

- **`search_patches`** — 反查 XML `PatchOperation`，支持按目标 `defName`、来源 Mod（`packageId`）或操作类（如 `PatchOperationReplace`）过滤。
- **`search_harmony`** — 反查 Harmony 补丁，支持按目标类 `targetType`、目标方法 `targetMethod` 或来源 `mod` 过滤。基于静态解析；运行时动态拼目标的补丁会标成 `dynamic`，需要再去读对应源码。

### 看 C# 和源码文件

- **`read_csharp_symbol`** — 知道类名或方法名就能直接读代码，不用先找文件路径。支持 `FoodUtility`、`RimWorld.FoodUtility`、`QuestUtility.IsQuestLodger` 或显式传 `memberName`，原版和 Mod 反编译代码都能查。
- **`search_source`** — 全文搜 XML 和 C#，支持按 `scope`（`all`、`vanilla`、`mods` 或单个 `packageId`）、`file_pattern` 和 `loaded_only` 过滤。纯标识符直接走 FTS5 索引（很快），正则才会回退到 `ripgrep`。
- **`read_file`** — 按相对路径和行号读取已导入资产里的文件。
- **`list_directory`** — 列出资产目录里的文件结构。

### Profile 与索引管理

- **`list_mods`** — 查看当前 profile 里有哪些 Mod、加载顺序以及依赖/兼容警告（`detail: true` + `page` 或传单个 `packageId` 可看详细目录和资产计数）。
- **`sync_profile`** — 刷新当前开发 profile 的导入资产和索引：
  - `fromGameConfig`（默认 `false`）：**只有**想用游戏 `ModsConfig.xml` 覆盖当前开发 profile 时才设为 `true`。
  - `full`（默认 `false`）：强制全量重导入和重建索引。
  - `gameRoot`（可选）：临时指定 RimWorld 安装目录。

---

## 底层是怎么跑的

### 增量同步

1. **按内容目录算指纹**：同步时会哈希游戏版本、排序后的 profile、元数据以及实际代码/配置目录（`About/`、`Defs/`、`Patches/`、`Source/`、`Assemblies/`、`Languages/`、`LoadFolders.xml`），跳过 `Textures/` 和 `Sounds/` 这些大体积二进制素材。
2. **Windows NTFS USN 快速跳过**：在 Windows 上如果能读取 NTFS 变更日志，没有文件改动时几十毫秒就能确认跳过；权限不够或日志滚动失效时会自动回退到普通扫描。
3. **分层局部更新**：
   - 单个 Mod 改动时，只重新导入和反编译有变化的 Mod（DLL 哈希没变会复用旧的反编译结果）。
   - `mods`、`csharp_index`、`harmony_patches` 和 `source_fts`（`contentless_delete=1`）按 Mod 增量替换；只是调整加载顺序时不会重算这些表。
   - 只有涉及 XML 的包内容或顺序变了、`LoadFolders.xml` 命中的版本目录变了，或者 `MayRequire` / `MayRequireAnyOf` / `PatchOperationFindMod` 的判断结果变了，才会重跑全局 XML 求值。
4. **不打断在线读取**：新文件先写到临时目录，SQLite 变更在单个 WAL 事务里一次性提交，正在查库的 MCP 客户端不会中途读到半成品。

### 贴合 RimWorld 加载规则

1. **加载顺序**：既支持按 `About.xml` 的 `loadAfter` / `loadBefore` / 依赖自动拓扑排序，也支持 `autoOrder: false` 原样照搬玩家顺序。
2. **先 Patch 后继承**：和 RimWorld 的 `LoadedModManager` 一致，先在原始 Def 树上按顺序跑完 `PatchOperation`，再做 `XmlInheritance` 继承展开。
3. **覆盖链记录**：每个 Def 都会保留是谁定义的、被谁覆盖了、最终哪一份生效。

---

## 开发与测试

```sh
# 类型检查
bun run type-check

# 跑单元测试
bun test

# 用当前索引验证 XML Patch 求值回归
bun run regression:patches

# 扫描整个创意工坊目录下的 Patch XML
bun run regression:patches --workshop
```

## 免责声明

Subcore 仅用于 RimWorld Mod 开发、兼容性排查和调试。

虽然根据 [RimWorld EULA](https://rimworldgame.com/eula)，为开发 Mod 反编译游戏本体是允许的，但第三方 Mod 仍受各自作者的协议和版权保护。**请勿使用本工具去逆向分析、反编译或提取作者选择闭源保护的 Mod。**

本工具仅作为本地开发辅助提供，具体使用方式及后果由使用者自行承担。因使用本工具引发的任何版权、协议或其他纠纷，作者概不负责。

## 开源协议

Subcore 整体采用 [GNU General Public License v3.0](./LICENSE)（`GPL-3.0-only`）开源。

项目包含源自 [**realloon/RimSage**](https://github.com/realloon/RimSage)（MIT 协议）的代码，原始版权与许可声明保留在 [THIRD_PARTY_LICENSES.md](./THIRD_PARTY_LICENSES.md)。

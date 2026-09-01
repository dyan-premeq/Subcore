import type { SQLQueryBindings } from 'bun:sqlite'

type Primitive = string | number | boolean | null | undefined

export type XmlNode = Primitive | XmlNode[] | { [key: string]: XmlNode }

export type XmlObject = Record<string, XmlNode>

export interface Def extends XmlObject {
  defType?: string
  defName?: string
  label?: string
  '@_Name'?: string
  '@_ParentName'?: string
  '@_Abstract'?: string
  '@_Inherit'?: string
  '@_MayRequire'?: string
  '@_MayRequireAnyOf'?: string
}

export interface CsharpIndexRow {
  typeName: string
  filePath: string
  startLine: number
  /** owning mods row; null = vanilla decompiled root (assets/Source) */
  modId: number | null
}

export type SqlNamedParams = Extract<SQLQueryBindings, Record<string, unknown>>

// #region Mod support (M1)

export type ModSource = 'builtin' | 'dlc' | 'local' | 'workshop'

export interface ModDependency {
  packageId: string
  displayName?: string
}

/** One <li> entry of a LoadFolders.xml version key. */
export interface LoadFolderEntry {
  /** '' means the mod root itself (the game's "/" shorthand). */
  folderName: string
  requiredAnyOf?: string[]
  requiredAllOf?: string[]
  disallowedAnyOf?: string[]
}

export interface ModInfo {
  /** lowercase normalized */
  packageId: string
  name: string
  author?: string
  source: ModSource
  /** original directory on disk */
  rootPath: string
  supportedVersions: string[]
  /** LoadFolders.xml parse result keyed by normalized version ("1.6", "default") */
  loadFolders: Record<string, LoadFolderEntry[]>
  /** legacy 'N.N' folders present at the mod root */
  versionDirs: string[]
  dependencies: ModDependency[]
  loadAfter: string[]
  loadBefore: string[]
  incompatibleWith: string[]
  warnings: string[]
  /** Data/<folder> folder name for builtin/dlc packages (used to map vanilla defs) */
  dataCategory?: string
}

export type ProfileBase = 'core-only' | 'all-dlc'

export interface Profile {
  name: string
  gameVersion?: string
  base: ProfileBase
  /** order irrelevant when autoOrder=true */
  mods: string[]
  autoOrder: boolean
}

export type LoadOrderIssueKind =
  | 'not-found'
  | 'missing-dependency'
  | 'incompatible-with'
  | 'version-unsupported'
  | 'cycle'

export interface LoadOrderIssue {
  packageId: string
  kind: LoadOrderIssueKind
  detail: string
}

export interface ResolvedLoadOrder {
  /** includes the vanilla base; loadOrder = array index */
  ordered: ModInfo[]
  issues: LoadOrderIssue[]
}

export interface ManifestMod extends ModInfo {
  loadOrder: number
  inProfile: boolean
  /** dist/assets-relative root ('' for builtin/dlc, 'Mods/<pkg>' for mods) */
  assetPath: string
  /** selected load folders, descending in-mod priority ('.' = mod root) */
  activeFolders: string[]
  /** files taking part in defs/patch indexing, relative to the mod root */
  effectiveFiles: string[]
  /** files shadowed by a higher-priority load folder (kept for reference) */
  shadowedFiles: string[]
  issues: LoadOrderIssue[]
}

export interface ModsManifest {
  generatedAt: string
  gameVersion: string
  profile: Profile
  /** in-profile mods, ordered by loadOrder (base first) */
  mods: ManifestMod[]
  /** discovered but not in the profile (metadata only, not copied/indexed) */
  discoveredNotInProfile: ModInfo[]
}

export interface ModsRow {
  modId: number
  packageId: string
  name: string | null
  source: ModSource
  assetPath: string
  loadOrder: number
  inProfile: number
  activeFolders: string | null
  warnings: string | null
  dataCategory: string | null
}

// #endregion

import {
  XmlCData,
  XmlDocument,
  XmlElement,
  XmlNode,
  XmlText,
  XmlTreeNode,
} from 'libxml2-wasm'
import { readFile } from 'node:fs/promises'
import { compareStrings } from './compare'
import type { AssetFileRef } from './asset-scan'

// #region Public interface

export type PatchOpStatus =
  | 'applied' // op reported success (after the success modifier)
  | 'no-match' // xpath selected nothing
  | 'failed' // matched but the operation returned false
  | 'skipped' // inside a Sequence after an earlier failure (never ran)
  | 'error' // xpath evaluation / malformed operation threw
  | 'unsupported-custom' // custom C# PatchOperation subclass
  | 'not-evaluated' // metadata-only run (--skip-patches)

/** One row of the patch_ops table (minus the autoincrement patchId). */
export interface PatchOpRecord {
  modId: number
  filePath: string
  /** document-order index across all operations, nesting flattened DFS */
  seq: number
  /** normalized lowercase op class, e.g. 'patchoperationadd' */
  opClass: string
  xpath: string | null
  xpathNorm: string | null
  /** defNames of the defs this op selected (backfilled for reverse lookup) */
  targetDefs: string[]
  status: PatchOpStatus
}

/** All defs of one origin, serialized as one `<Defs>` document. */
export interface PatchedDefGroup {
  modId: number
  loadOrder: number
  filePath: string
  xml: string
  defNames: string[]
}

export interface PatchEvaluationResult {
  /** in application order (mod loadOrder × file order × document order) */
  opRecords: PatchOpRecord[]
  defGroups: PatchedDefGroup[]
  /** defName → modIds whose patches modified it */
  changedBy: Map<string, number[]>
  stats: Record<PatchOpStatus, number>
}

export interface PatchEvaluatorOptions {
  /**
   * Display names of profile-active mods, for PatchOperationFindMod
   * (game: ModLister.HasActiveModWithName — exact, case-sensitive).
   */
  activeModNames: ReadonlySet<string>
  onFindMod?: (names: string[]) => void
}

// #endregion

/**
 * Load order marker for defs introduced by patches: DefDatabase.AddDef runs
 * patch-added defs after every mod definition, so they override all of them.
 * The JSON pipeline sorts groups by loadOrder, last write wins.
 */
export const PATCH_DEF_LOAD_ORDER = 2147483647

interface NodeOrigin {
  modId: number
  loadOrder: number
  filePath: string
}

/**
 * The PatchOperations interpreter: the only code holding .NET change
 * semantics. Builds the unified `<Defs>` tree exactly like
 * LoadedModManager.CombineIntoUnifiedXML (same-name defs coexist, no
 * merging), applies every patch in game order (XPath 1.0 via libxml2-wasm,
 * matching System.Xml.XmlDocument.SelectNodes), then serializes each def
 * back to XML text at the pipeline boundary.
 *
 * All "is it active" judgments (FindMod) run against the dev profile, never
 * against the player's ModsConfig.
 */
export class PatchEvaluator {
  private readonly doc: XmlDocument
  private readonly defsRoot: XmlElement
  /** `/` document node: context for both `Defs/...` and `/Defs/...` XPaths. */
  private readonly docNode: XmlNode

  /**
   * Keyed by libxml2 C node pointer because libxml2-wasm constructs a fresh
   * JS wrapper object on each traversal/query call. Any top-level def
   * removed or replaced MUST go through `releaseIfTopLevelDef` before calling
   * `.remove()` so freed WASM addresses cannot alias new nodes.
   */
  private readonly nodeSource = new Map<number, NodeOrigin>()
  /** top-level def pointer → modIds whose patches selected it for modification */
  private readonly changedDefs = new Map<number, Set<number>>()
  /** @Name → top-level def pointers registered under that name (inheritance edges) */
  private readonly nodesByName = new Map<string, number[]>()

  readonly opRecords: PatchOpRecord[] = []

  private readonly options: PatchEvaluatorOptions
  private seq = 0

  constructor(options: PatchEvaluatorOptions) {
    this.options = options
    this.doc = XmlDocument.create()
    this.defsRoot = this.doc.createRoot('Defs')
    const rootNode = this.doc.get('/')
    if (!rootNode) {
      this.doc.dispose()
      throw new Error('Failed to obtain document node for PatchEvaluator')
    }
    this.docNode = rootNode
  }

  dispose(): void {
    this.nodeSource.clear()
    this.changedDefs.clear()
    this.nodesByName.clear()
    this.doc.dispose()
  }

  [Symbol.dispose](): void {
    this.dispose()
  }

  // #region Tree building (game: CombineIntoUnifiedXML)

  /**
   * Mounts every def of `files` into the unified tree, sorted by
   * (loadOrder, filePath) — the order the game combines XML assets.
   * Unreadable/unparseable files are warned about and skipped (game:
   * LoadableXmlAsset with xmlDoc == null).
   */
  async buildTree(files: AssetFileRef[]): Promise<void> {
    const sorted = [...files].sort(
      (a, b) => a.loadOrder - b.loadOrder || compareStrings(a.filePath, b.filePath),
    )
    const origin = (ref: AssetFileRef): NodeOrigin => ({
      modId: ref.modId,
      loadOrder: ref.loadOrder,
      filePath: ref.filePath,
    })
    for (const ref of sorted) {
      const fileDoc = await this.parseXmlDoc(ref, 'Defs')
      if (!fileDoc) continue
      try {
        for (const child of childElements(fileDoc.root)) {
          const imported = copyElementInto(child, name => this.defsRoot.addElement(name))
          const ptr = nodePtr(imported)
          this.nodeSource.set(ptr, origin(ref))
          const name = imported.attr('Name')?.value
          if (name) this.addNameIndex(name, ptr)
        }
      } finally {
        fileDoc.dispose()
      }
    }
  }

  // #endregion

  // #region Patch application (game: ModContentPack.LoadPatches + ApplyPatches)

  /**
   * Applies every patch file in game order: mod loadOrder × file enumeration
   * × document order (`<Patch>` roots, `<Operation>` children only).
   */
  async applyPatches(files: AssetFileRef[]): Promise<void> {
    const sorted = [...files].sort(
      (a, b) => a.loadOrder - b.loadOrder || compareStrings(a.filePath, b.filePath),
    )
    for (const ref of sorted) {
      const fileDoc = await this.parseXmlDoc(ref, 'Patch')
      if (!fileDoc) continue
      try {
        for (const opEl of childElements(fileDoc.root)) {
          if (opEl.name !== 'Operation') {
            console.warn(
              `[patch-evaluator] unexpected element in patch XML ${ref.filePath}, expected 'Operation'`,
            )
            continue
          }
          this.applyOperation(opEl, ref.modId, ref.filePath)
        }
      } finally {
        fileDoc.dispose()
      }
    }
  }

  /**
   * Parses patch files and records operation metadata without applying
   * anything (--skip-patches): search_patches stays usable, patched_defs
   * stays empty.
   */
  async collectPatchMetadata(files: AssetFileRef[]): Promise<void> {
    const sorted = [...files].sort(
      (a, b) => a.loadOrder - b.loadOrder || compareStrings(a.filePath, b.filePath),
    )
    for (const ref of sorted) {
      const fileDoc = await this.parseXmlDoc(ref, 'Patch')
      if (!fileDoc) continue
      try {
        for (const opEl of childElements(fileDoc.root)) {
          if (opEl.name !== 'Operation') continue
          this.collectMetadata(opEl, ref)
        }
      } finally {
        fileDoc.dispose()
      }
    }
  }

  private collectMetadata(opEl: XmlElement, ref: AssetFileRef): void {
    const xpath = childText(opEl, 'xpath')
    const opClass = normalizeOpClass(opEl.attr('Class')?.value ?? null)
    this.opRecords.push({
      modId: ref.modId,
      filePath: ref.filePath,
      seq: this.seq++,
      opClass,
      xpath,
      xpathNorm: xpath !== null ? normalizeXpath(xpath) : null,
      targetDefs: [],
      // statically decidable: a custom C# class can never be applied
      status: isKnownOpClass(opClass) ? 'not-evaluated' : 'unsupported-custom',
    })
    this.walkNestedOperations(opEl, nested => this.collectMetadata(nested, ref))
  }

  /** Visits nested operations of containers (match/nomatch/operations li). */
  private walkNestedOperations(opEl: XmlElement, visit: (el: XmlElement) => void): void {
    // <match>/<nomatch> hold a single PatchOperation; <operations> holds a
    // list where each <li> IS the operation element (Class attr on the li)
    for (const name of ['match', 'nomatch']) {
      const branch = childElement(opEl, name)
      if (branch && branch.attr('Class')) visit(branch)
    }
    const operations = childElement(opEl, 'operations')
    if (operations) for (const li of childElements(operations)) visit(li)
  }

  // #endregion

  // #region Operation dispatch (game: PatchOperation.Apply + subclasses)

  /**
   * Applies one operation element. The returned bool is the post-`success`
   * result (game Apply); `record.status` mirrors it for indexing.
   */
  private applyOperation(
    opEl: XmlElement,
    modId: number,
    filePath: string,
    skipped = false,
  ): boolean {
    const record: PatchOpRecord = {
      modId,
      filePath,
      seq: this.seq++,
      opClass: normalizeOpClass(opEl.attr('Class')?.value ?? null),
      xpath: null,
      xpathNorm: null,
      targetDefs: [],
      status: 'applied',
    }
    this.opRecords.push(record)

    if (skipped) {
      // a Sequence stops at its first failure: the rest never runs
      record.status = 'skipped'
      record.xpath = childText(opEl, 'xpath')
      record.xpathNorm = record.xpath !== null ? normalizeXpath(record.xpath) : null
      this.walkNestedOperations(opEl, nested => this.applyOperation(nested, modId, filePath, true))
      return false
    }

    let raw: boolean
    try {
      raw = this.applyWorker(opEl, record)
    } catch (error) {
      // game: ApplyPatches catches per-patch exceptions and logs an error
      record.status = 'error'
      console.warn(`[patch-evaluator] ${record.opClass} failed in ${filePath}: ${error}`)
      return false
    }
    return this.applySuccessModifier(opEl, record, raw)
  }

  /** game: the `success` field post-processing in PatchOperation.Apply */
  private applySuccessModifier(opEl: XmlElement, record: PatchOpRecord, raw: boolean): boolean {
    const success = childText(opEl, 'success')?.toLowerCase()
    let result = raw
    if (success === 'always') result = true
    else if (success === 'never') result = false
    else if (success === 'invert') result = !raw

    // status mirrors the final Apply result, like the game's
    // neverSucceeded/Complete error log
    if (result && (record.status === 'no-match' || record.status === 'failed')) {
      record.status = 'applied'
    } else if (!result && record.status === 'applied') {
      record.status = 'failed'
    }
    return result
  }

  /** game: PatchOperation.ApplyWorker overrides, dispatched on Class */
  private applyWorker(opEl: XmlElement, record: PatchOpRecord): boolean {
    switch (record.opClass) {
      case 'patchoperationadd':
        return this.opAdd(opEl, record)
      case 'patchoperationinsert':
        return this.opInsert(opEl, record)
      case 'patchoperationreplace':
        return this.opReplace(opEl, record)
      case 'patchoperationremove':
        return this.opRemove(opEl, record)
      case 'patchoperationaddmodextension':
        return this.opAddModExtension(opEl, record)
      case 'patchoperationattributeset':
        return this.opAttribute(opEl, record, 'set')
      case 'patchoperationattributeadd':
        return this.opAttribute(opEl, record, 'add')
      case 'patchoperationattributeremove':
        return this.opAttribute(opEl, record, 'remove')
      case 'patchoperationsetname':
        return this.opSetName(opEl, record)
      case 'patchoperationsequence':
        return this.opSequence(opEl, record)
      case 'patchoperationconditional':
        return this.opConditional(opEl, record)
      case 'patchoperationfindmod':
        return this.opFindMod(opEl, record)
      case 'patchoperationtest':
        return this.opTest(opEl, record)
      default:
        record.status = 'unsupported-custom'
        console.warn(
          `[patch-evaluator] unsupported custom PatchOperation class "${opEl.attr('Class')?.value ?? ''}" in ${record.filePath}`,
        )
        return false
    }
  }

  // #endregion

  // #region Individual operations (each mirrors its decompiled ApplyWorker)

  /**
   * PatchOperationAdd: `<value>` children are appended to (order=Append,
   * default) or prepended into (order=Prepend) each selected node.
   */
  private opAdd(opEl: XmlElement, record: PatchOpRecord): boolean {
    const value = this.requiredValue(opEl, record)
    const prepend = (childText(opEl, 'order') ?? 'Append').toLowerCase() === 'prepend'
    const targets = this.selectElements(opEl, record)
    if (!targets) return false

    const children = meaningfulChildren(value)
    for (const target of targets) {
      const imported: XmlElement[] = []
      if (prepend) {
        // game: reverse ChildNodes, PrependChild each — equivalent to
        // inserting each in front of the current first child, reversed
        for (const child of [...children].reverse()) {
          const first = target.firstChild
          const created = cloneTreeNode(
            child,
            first
              ? {
                  element: n => first.prependElement(n),
                  text: t => first.prependText(t),
                  cdata: c => first.prependCData(c),
                }
              : {
                  element: n => target.addElement(n),
                  text: t => target.addText(t),
                  cdata: c => target.addCData(c),
                },
          )
          if (created instanceof XmlElement) imported.push(created)
        }
      } else {
        for (const child of children) {
          const created = cloneTreeNode(child, {
            element: n => target.addElement(n),
            text: t => target.addText(t),
            cdata: c => target.addCData(c),
          })
          if (created instanceof XmlElement) imported.push(created)
        }
      }
      this.claimPatchAddedDefs(imported, record)
    }
    return true
  }

  /**
   * PatchOperationInsert: `<value>` children become siblings.
   * order=Append → InsertAfter with the target as a FIXED refChild (game
   * code never moves it), so ≥2 children land in reverse document order;
   * Prepend (the default!) → InsertBefore in reverse.
   */
  private opInsert(opEl: XmlElement, record: PatchOpRecord): boolean {
    const value = this.requiredValue(opEl, record)
    const append = (childText(opEl, 'order') ?? 'Prepend').toLowerCase() === 'append'
    const targets = this.selectTreeNodes(opEl, record)
    if (!targets) return false

    const children = meaningfulChildren(value)
    for (const target of targets) {
      if (!target.parent) continue
      const imported: XmlElement[] = []
      if (append) {
        // game: parentNode.InsertAfter(..., xmlNode) — refChild stays the
        // target, each child lands directly after it (later child first)
        for (const child of children) {
          const created = cloneTreeNode(child, {
            element: n => target.appendElement(n),
            text: t => target.appendText(t),
            cdata: c => target.appendCData(c),
          })
          if (created instanceof XmlElement) imported.push(created)
        }
      } else {
        for (const child of [...children].reverse()) {
          const created = cloneTreeNode(child, {
            element: n => target.prependElement(n),
            text: t => target.prependText(t),
            cdata: c => target.prependCData(c),
          })
          if (created instanceof XmlElement) imported.push(created)
        }
      }
      this.claimPatchAddedDefs(imported, record)
    }
    return true
  }

  /**
   * PatchOperationReplace: the selected node is replaced by ALL children of
   * `<value>` (decompiled code iterates node.ChildNodes, not just the first).
   */
  private opReplace(opEl: XmlElement, record: PatchOpRecord): boolean {
    const value = this.requiredValue(opEl, record)
    const rawTargets = this.selectTreeNodes(opEl, record)
    if (!rawTargets) return false

    const children = meaningfulChildren(value)
    for (const target of filterOutDescendants(rawTargets)) {
      if (!target.parent) continue
      const imported: XmlElement[] = []
      for (const child of children) {
        const created = cloneTreeNode(child, {
          element: n => target.prependElement(n),
          text: t => target.prependText(t),
          cdata: c => target.prependCData(c),
        })
        if (created instanceof XmlElement) imported.push(created)
      }
      this.claimPatchAddedDefs(imported, record)
      this.releaseIfTopLevelDef(target)
      target.remove()
    }
    return true
  }

  /** PatchOperationRemove */
  private opRemove(opEl: XmlElement, record: PatchOpRecord): boolean {
    const rawTargets = this.selectTreeNodes(opEl, record)
    if (!rawTargets) return false
    for (const target of filterOutDescendants(rawTargets)) {
      if (!target.parent) continue
      this.releaseIfTopLevelDef(target)
      target.remove()
    }
    return true
  }

  /**
   * PatchOperationAddModExtension: appends `<value>` children into the
   * selected def's `<modExtensions>` container, creating it if absent.
   */
  private opAddModExtension(opEl: XmlElement, record: PatchOpRecord): boolean {
    const value = this.requiredValue(opEl, record)
    const targets = this.selectElements(opEl, record)
    if (!targets) return false

    const children = meaningfulChildren(value)
    for (const target of targets) {
      // game: xmlNode["modExtensions"] — first direct child by that name
      const container = childElement(target, 'modExtensions') ?? target.addElement('modExtensions')
      const imported: XmlElement[] = []
      for (const child of children) {
        const created = cloneTreeNode(child, {
          element: n => container.addElement(n),
          text: t => container.addText(t),
          cdata: c => container.addCData(c),
        })
        if (created instanceof XmlElement) imported.push(created)
      }
      this.claimPatchAddedDefs(imported, record)
    }
    return true
  }

  /**
   * PatchOperationAttribute{Set,Add,Remove}. Note Add only succeeds when the
   * attribute was absent (game returns false otherwise).
   */
  private opAttribute(
    opEl: XmlElement,
    record: PatchOpRecord,
    kind: 'set' | 'add' | 'remove',
  ): boolean {
    const attribute = childText(opEl, 'attribute')
    if (!attribute) {
      record.status = 'failed'
      return false
    }
    const targets = this.selectElements(opEl, record)
    if (!targets) return false

    let result = false
    for (const target of targets) {
      const isTopDef = target.parent?.isSameNode(this.defsRoot) ?? false
      const oldName = isTopDef && attribute === 'Name' ? target.attr('Name')?.value ?? null : null
      if (kind === 'set') {
        const nextVal = childText(opEl, 'value') ?? ''
        target.setAttr(attribute, nextVal)
        if (isTopDef && attribute === 'Name') {
          this.updateNameIndex(nodePtr(target), oldName, nextVal || null)
        }
        result = true
      } else if (kind === 'add') {
        if (!target.attr(attribute)) {
          const nextVal = childText(opEl, 'value') ?? ''
          target.setAttr(attribute, nextVal)
          if (isTopDef && attribute === 'Name' && nextVal) {
            this.updateNameIndex(nodePtr(target), null, nextVal)
          }
          result = true
        }
      } else {
        const existing = target.attr(attribute)
        if (existing) {
          existing.remove()
          if (isTopDef && attribute === 'Name') {
            this.updateNameIndex(nodePtr(target), oldName, null)
          }
          result = true
        }
      }
    }
    if (!result) record.status = 'failed'
    return result
  }

  /**
   * PatchOperationSetName: CreateElement(name) + move child nodes — the
   * game copies InnerXml only, so ALL attributes of the original node
   * (@Name/@ParentName/@MayRequire…) are dropped.
   */
  private opSetName(opEl: XmlElement, record: PatchOpRecord): boolean {
    const name = childText(opEl, 'name')
    if (!name) {
      record.status = 'failed'
      return false
    }
    const rawTargets = this.selectElements(opEl, record)
    if (!rawTargets) return false

    for (const target of filterOutDescendants(rawTargets)) {
      if (!target.parent) continue
      const oldPtr = nodePtr(target)
      const renamed = target.prependElement(name)
      for (const child of meaningfulChildren(target)) {
        cloneTreeNode(child, {
          element: n => renamed.addElement(n),
          text: t => renamed.addText(t),
          cdata: c => renamed.addCData(c),
        })
      }
      const newPtr = nodePtr(renamed)
      const source = this.nodeSource.get(oldPtr)
      if (source) this.nodeSource.set(newPtr, source)
      const changed = this.changedDefs.get(oldPtr)
      if (changed) this.changedDefs.set(newPtr, new Set(changed))
      this.releaseIfTopLevelDef(target)
      target.remove()
      this.claimPatchAddedDefs([renamed], record)
    }
    return true
  }

  /**
   * PatchOperationSequence: run operations in order, stop at the first
   * failure — remaining ops are recorded as skipped, never applied.
   */
  private opSequence(opEl: XmlElement, record: PatchOpRecord): boolean {
    const operations = childElement(opEl, 'operations')
    if (!operations) return true

    const list = childElements(operations)
    for (let i = 0; i < list.length; i++) {
      if (this.applyOperation(list[i]!, record.modId, record.filePath)) continue
      // first failure stops the sequence; remaining ops are recorded as
      // skipped but never applied (game: lastFailedOperation semantics)
      for (let j = i + 1; j < list.length; j++) {
        this.applyOperation(list[j]!, record.modId, record.filePath, true)
      }
      return false
    }
    return true
  }

  /**
   * PatchOperationConditional: fall-through semantics copied from the
   * decompiled ApplyWorker — match missing + hit → `nomatch != null`;
   * nomatch missing + no hit → true iff a match exists.
   */
  private opConditional(opEl: XmlElement, record: PatchOpRecord): boolean {
    const match = childElement(opEl, 'match')
    const nomatch = childElement(opEl, 'nomatch')
    const hit = this.selectFirst(record, opEl)

    if (hit) {
      if (match) return this.applyOperation(match, record.modId, record.filePath)
      return nomatch !== null
    }
    if (nomatch) return this.applyOperation(nomatch, record.modId, record.filePath)
    return match !== null
  }

  /**
   * PatchOperationFindMod: any mod display name in `<mods>` matching an
   * active mod (exact, case-sensitive — ModLister.HasActiveModWithName).
   */
  private opFindMod(opEl: XmlElement, record: PatchOpRecord): boolean {
    const modsEl = childElement(opEl, 'mods')
    const names: string[] = []
    if (modsEl) {
      for (const li of childElements(modsEl)) {
        const name = li.content.trim()
        if (name) names.push(name)
      }
    }
    const match = childElement(opEl, 'match')
    const nomatch = childElement(opEl, 'nomatch')

    this.options.onFindMod?.(names)
    if (names.some(name => this.options.activeModNames.has(name))) {
      if (match) return this.applyOperation(match, record.modId, record.filePath)
      return true
    }
    if (nomatch) return this.applyOperation(nomatch, record.modId, record.filePath)
    return true
  }

  /** PatchOperationTest: true iff the xpath selects at least one node. */
  private opTest(opEl: XmlElement, record: PatchOpRecord): boolean {
    const hit = this.selectFirst(record, opEl)
    if (!hit) record.status = 'no-match'
    return hit
  }

  // #endregion

  // #region XPath + bookkeeping helpers

  private selectElements(opEl: XmlElement, record: PatchOpRecord): XmlElement[] | null {
    return this.selectAndRecord(opEl, record, (n): n is XmlElement => n instanceof XmlElement)
  }

  private selectTreeNodes(opEl: XmlElement, record: PatchOpRecord): XmlTreeNode[] | null {
    return this.selectAndRecord(
      opEl,
      record,
      (n): n is XmlTreeNode =>
        n instanceof XmlElement || n instanceof XmlText || n instanceof XmlCData,
    )
  }

  /**
   * Evaluates the op's xpath against the `/` document node. Returns matching
   * nodes matching `guard` with targetDefs backfilled and changedDefs marked,
   * or null on no-match / error.
   */
  private selectAndRecord<T extends XmlNode>(
    opEl: XmlElement,
    record: PatchOpRecord,
    guard: (node: XmlNode) => node is T,
  ): T[] | null {
    const xpath = childText(opEl, 'xpath')
    if (!xpath) {
      record.status = 'failed'
      console.warn(`[patch-evaluator] operation without <xpath> in ${record.filePath}`)
      return null
    }
    record.xpath = xpath
    record.xpathNorm = normalizeXpath(xpath)

    let nodes: XmlNode[]
    try {
      nodes = this.docNode.find(xpath)
    } catch (error) {
      record.status = 'error'
      console.warn(`[patch-evaluator] xpath error in ${record.filePath}: ${error}`)
      return null
    }
    const matched = nodes.filter(guard)
    if (matched.length === 0) {
      record.status = 'no-match'
      return null
    }

    for (const node of matched) {
      const def = this.defAncestorOf(node)
      if (!def) continue
      // concrete defs are identified by defName, abstract templates by @Name
      const defName = directChildText(def, 'defName') ?? def.attr('Name')?.value ?? null
      if (!defName) continue
      if (!record.targetDefs.includes(defName)) record.targetDefs.push(defName)

      const defPtr = nodePtr(def)
      let changed = this.changedDefs.get(defPtr)
      if (!changed) {
        changed = new Set()
        this.changedDefs.set(defPtr, changed)
      }
      changed.add(record.modId)
    }
    return matched
  }

  /**
   * xpath hit test for Conditional/Test (no targetDefs, no changes marked).
   * Throws on invalid xpath — the caller's catch records status=error.
   */
  private selectFirst(record: PatchOpRecord, opEl: XmlElement): boolean {
    const xpath = childText(opEl, 'xpath')
    if (!xpath) {
      record.status = 'failed'
      console.warn(`[patch-evaluator] operation without <xpath> in ${record.filePath}`)
      return false
    }
    record.xpath = xpath
    record.xpathNorm = normalizeXpath(xpath)
    return this.docNode.get(xpath) !== null
  }

  /** Nearest ancestor-or-self that is a direct child of the unified <Defs>. */
  private defAncestorOf(node: XmlNode): XmlElement | null {
    let current: XmlNode | null = node
    while (current && !current.isSameNode(this.defsRoot)) {
      const parent: XmlElement | null = current.parent
      if (!parent) return null
      if (parent.isSameNode(this.defsRoot) && current instanceof XmlElement) {
        return current
      }
      current = parent
    }
    return null
  }

  /**
   * Nodes a patch placed directly under the unified <Defs> are patch-added
   * defs: they get the patch's origin and override everything.
   */
  private claimPatchAddedDefs(imported: XmlElement[], record: PatchOpRecord): void {
    for (const node of imported) {
      if (!(node.parent?.isSameNode(this.defsRoot))) continue
      const ptr = nodePtr(node)
      if (!this.nodeSource.has(ptr)) {
        this.nodeSource.set(ptr, {
          filePath: record.filePath,
          modId: record.modId,
          loadOrder: PATCH_DEF_LOAD_ORDER,
        })
      }
      const name = node.attr('Name')?.value
      if (name) this.addNameIndex(name, ptr)
    }
  }

  /** Must run BEFORE `target.remove()` so freed pointers never stay indexed. */
  private releaseIfTopLevelDef(target: XmlTreeNode): void {
    if (!(target instanceof XmlElement)) return
    if (!target.parent?.isSameNode(this.defsRoot)) return
    const ptr = nodePtr(target)
    this.nodeSource.delete(ptr)
    this.changedDefs.delete(ptr)
    const name = target.attr('Name')?.value
    if (name) this.removeNameIndex(name, ptr)
  }

  private addNameIndex(name: string, ptr: number): void {
    const list = this.nodesByName.get(name) ?? []
    if (!list.includes(ptr)) list.push(ptr)
    this.nodesByName.set(name, list)
  }

  private removeNameIndex(name: string, ptr: number): void {
    const list = this.nodesByName.get(name)
    if (!list) return
    const next = list.filter(item => item !== ptr)
    if (next.length === 0) this.nodesByName.delete(name)
    else this.nodesByName.set(name, next)
  }

  private updateNameIndex(ptr: number, oldName: string | null, newName: string | null): void {
    if (oldName === newName) return
    if (oldName) this.removeNameIndex(oldName, ptr)
    if (newName) this.addNameIndex(newName, ptr)
  }

  private requiredValue(opEl: XmlElement, record: PatchOpRecord): XmlElement {
    const value = childElement(opEl, 'value')
    if (!value) {
      record.status = 'failed'
      throw new Error(`operation without <value> in ${record.filePath}`)
    }
    return value
  }

  private async parseXmlDoc(ref: AssetFileRef, expectedRoot: string): Promise<XmlDocument | null> {
    let text: string
    try {
      text = await readFile(ref.absPath, 'utf8')
    } catch (error) {
      console.warn(`[patch-evaluator] cannot read ${ref.filePath}: ${error}`)
      return null
    }
    let doc: XmlDocument
    try {
      doc = XmlDocument.fromString(text)
    } catch (error) {
      console.warn(`[patch-evaluator] XML parse failed for ${ref.filePath}: ${error}`)
      return null
    }
    try {
      if (doc.root.name !== expectedRoot) {
        console.warn(
          `[patch-evaluator] unexpected root element in ${ref.filePath}, expected '${expectedRoot}'`,
        )
        doc.dispose()
        return null
      }
      return doc
    } catch (error) {
      doc.dispose()
      console.warn(`[patch-evaluator] XML parse failed for ${ref.filePath}: ${error}`)
      return null
    }
  }

  // #endregion

  // #region Serialization (pipeline boundary to the JSON layer)

  serialize(): { defGroups: PatchedDefGroup[]; changedBy: Map<string, number[]> } {
    this.propagateChangedThroughInheritance()

    const groups = new Map<string, PatchedDefGroup & { xmlParts: string[] }>()
    const changedBy = new Map<string, number[]>()

    for (const def of childElements(this.defsRoot)) {
      // every node under defsRoot carries a source: set in buildTree,
      // claimPatchAddedDefs, or carried over by opSetName
      const ptr = nodePtr(def)
      const source = this.nodeSource.get(ptr)!
      const key = `${source.loadOrder}|${source.modId}|${source.filePath}`
      let group = groups.get(key)
      if (!group) {
        group = {
          modId: source.modId,
          loadOrder: source.loadOrder,
          filePath: source.filePath,
          xml: '',
          defNames: [],
          xmlParts: [],
        }
        groups.set(key, group)
      }
      group.xmlParts.push(def.toString({ format: false }))

      const defName = directChildText(def, 'defName') ?? def.attr('Name')?.value ?? null
      if (!defName) continue
      group.defNames.push(defName)

      const changed = this.changedDefs.get(ptr)
      if (changed && changed.size > 0) {
        const modIds = changedBy.get(defName) ?? []
        for (const modId of changed) {
          if (!modIds.includes(modId)) modIds.push(modId)
        }
        changedBy.set(defName, modIds)
      }
    }

    // group insertion order = tree order = (loadOrder, filePath, doc order);
    // the JSON pipeline relies on exactly this ordering
    const defGroups: PatchedDefGroup[] = []
    for (const group of groups.values()) {
      defGroups.push({
        modId: group.modId,
        loadOrder: group.loadOrder,
        filePath: group.filePath,
        defNames: group.defNames,
        xml: `<Defs>${group.xmlParts.join('')}</Defs>`,
      })
    }

    return { defGroups, changedBy }
  }

  /**
   * A patch on an abstract template flows into every inheriting def (patch
   * runs BEFORE inheritance resolution): propagate changers down the
   * @ParentName edges until a fixpoint, respecting GetBestParentFor's
   * loadOrder <= child constraint.
   */
  private propagateChangedThroughInheritance(): void {
    const defs = childElements(this.defsRoot)
    let changedAny = true
    while (changedAny) {
      changedAny = false
      for (const def of defs) {
        const defPtr = nodePtr(def)
        const own = this.changedDefs.get(defPtr)
        if (own && own.size > 0) continue // already marked; nothing to receive
        const parentName = def.attr('ParentName')?.value
        if (!parentName) continue
        const childLoadOrder = this.nodeSource.get(defPtr)?.loadOrder ?? -1

        const changers = new Set<number>()
        for (const candidatePtr of this.nodesByName.get(parentName) ?? []) {
          if ((this.nodeSource.get(candidatePtr)?.loadOrder ?? -1) > childLoadOrder) {
            continue // parent defined later than the child: not its parent
          }
          for (const modId of this.changedDefs.get(candidatePtr) ?? []) changers.add(modId)
        }
        if (changers.size === 0) continue

        const target = own ?? new Set<number>()
        for (const modId of changers) {
          if (!target.has(modId)) {
            target.add(modId)
            changedAny = true
          }
        }
        this.changedDefs.set(defPtr, target)
      }
    }
  }

  stats(): Record<PatchOpStatus, number> {
    const stats: Record<PatchOpStatus, number> = {
      applied: 0,
      'no-match': 0,
      failed: 0,
      skipped: 0,
      error: 0,
      'unsupported-custom': 0,
      'not-evaluated': 0,
    }
    for (const record of this.opRecords) stats[record.status]++
    return stats
  }

  // #endregion
}

// #region Module-level helpers

function nodePtr(node: XmlNode): number {
  const ptr = (node as unknown as { _nodePtr?: number })._nodePtr
  if (typeof ptr !== 'number' || ptr === 0) {
    throw new Error('libxml2-wasm XmlNode missing valid _nodePtr')
  }
  return ptr
}

/** Drops any matched node whose ancestor is also in `nodes` (avoids UAF on remove). */
function filterOutDescendants<T extends XmlTreeNode>(nodes: T[]): T[] {
  const selected = new Set(nodes.map(nodePtr))
  return nodes.filter(node => {
    let parent: XmlElement | null = node.parent
    while (parent) {
      if (selected.has(nodePtr(parent))) return false
      parent = parent.parent
    }
    return true
  })
}

function childElements(el: XmlElement): XmlElement[] {
  const out: XmlElement[] = []
  for (let child = el.firstChild; child; child = child.next) {
    if (child instanceof XmlElement) out.push(child)
  }
  return out
}

function childElement(el: XmlElement, name: string): XmlElement | null {
  for (let child = el.firstChild; child; child = child.next) {
    if (child instanceof XmlElement && child.name === name) return child
  }
  return null
}

function childText(el: XmlElement, name: string): string | null {
  const child = childElement(el, name)
  return child ? child.content : null
}

function directChildText(el: XmlElement, name: string): string | null {
  return childElement(el, name)?.content.trim() ?? null
}

/**
 * Significant children of an element, mirroring RimWorld's
 * XmlReaderSettings { IgnoreWhitespace = true, IgnoreComments = true }.
 */
function meaningfulChildren(el: XmlElement): XmlTreeNode[] {
  const out: XmlTreeNode[] = []
  for (let child = el.firstChild; child; child = child.next) {
    if (child instanceof XmlElement || child instanceof XmlCData) {
      out.push(child)
    } else if (child instanceof XmlText && child.content.trim() !== '') {
      out.push(child)
    }
  }
  return out
}

interface NodeSink {
  element(name: string): XmlElement
  text(content: string): XmlText
  cdata(content: string): XmlCData
}

function cloneTreeNode(src: XmlTreeNode, sink: NodeSink): XmlTreeNode | null {
  if (src instanceof XmlElement) return copyElementInto(src, name => sink.element(name))
  if (src instanceof XmlText) return src.content.trim() !== '' ? sink.text(src.content) : null
  if (src instanceof XmlCData) return sink.cdata(src.content)
  return null
}

function copyElementInto(src: XmlElement, create: (name: string) => XmlElement): XmlElement {
  const dst = create(src.name)
  const nsDecls = src.nsDeclarations
  for (const [prefix, uri] of Object.entries(nsDecls)) {
    dst.addNsDeclaration(uri, prefix || undefined)
  }
  if (src.prefix) dst.prefix = src.prefix
  for (const attr of src.attrs) {
    dst.setAttr(attr.name, attr.value, attr.prefix || undefined)
  }
  for (const child of meaningfulChildren(src)) {
    cloneTreeNode(child, {
      element: name => dst.addElement(name),
      text: content => dst.addText(content),
      cdata: content => dst.addCData(content),
    })
  }
  return dst
}

/** All PatchOperation classes the interpreter implements (lowercase). */
const KNOWN_OP_CLASSES = new Set([
  'patchoperationadd',
  'patchoperationinsert',
  'patchoperationreplace',
  'patchoperationremove',
  'patchoperationaddmodextension',
  'patchoperationattributeset',
  'patchoperationattributeadd',
  'patchoperationattributeremove',
  'patchoperationsetname',
  'patchoperationsequence',
  'patchoperationconditional',
  'patchoperationfindmod',
  'patchoperationtest',
])

export function isKnownOpClass(opClass: string): boolean {
  return KNOWN_OP_CLASSES.has(opClass)
}

function normalizeOpClass(classAttr: string | null): string {
  return (classAttr ?? '').toLowerCase()
}

/**
 * Minimal xpath normalization for the xpathNorm column: trim, collapse
 * whitespace runs, unify string literals to single quotes. No case folding —
 * xpath is case-sensitive in both engines.
 */
export function normalizeXpath(xpath: string): string {
  // in XPath, double quotes only occur around string literals
  return xpath
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/"([^"]*)"/g, "'$1'")
}

// #endregion

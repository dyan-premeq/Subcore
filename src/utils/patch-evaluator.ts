import { DOMParser, XMLSerializer } from 'slimdom'
import type { Document, Element, Node } from 'slimdom'
import { evaluateXPathToFirstNode, evaluateXPathToNodes } from 'fontoxpath'
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
}

// #endregion

/**
 * Load order marker for defs introduced by patches: DefDatabase.AddDef runs
 * patch-added defs after every mod definition, so they override all of them
 * (§4.2). The JSON pipeline sorts groups by loadOrder, last write wins.
 */
export const PATCH_DEF_LOAD_ORDER = 2147483647

const ELEMENT = 1
const TEXT = 3

/**
 * The PatchOperations interpreter (design doc §6.6 layer ①): the only code
 * holding .NET change semantics. Builds the unified `<Defs>` tree exactly
 * like LoadedModManager.CombineIntoUnifiedXML (same-name defs coexist, no
 * merging), applies every patch in game order, then serializes each def back
 * to XML text at the pipeline boundary.
 *
 * All "is it active" judgments (FindMod) run against the dev profile, never
 * against the player's ModsConfig.
 */
export class PatchEvaluator {
  private readonly doc: Document
  private readonly defsRoot: Element
  private readonly serializer = new XMLSerializer()
  private readonly parser = new DOMParser()

  /** def element → origin (identity only; absPath is irrelevant after read) */
  private readonly nodeSource = new WeakMap<Node, {
    modId: number
    loadOrder: number
    filePath: string
  }>()
  /** def element → modIds whose patches selected it for modification */
  private readonly changedDefs = new WeakMap<Element, Set<number>>()
  /** @Name → def elements registered under that name (inheritance edges) */
  private readonly nodesByName = new Map<string, Element[]>()

  readonly opRecords: PatchOpRecord[] = []

  private readonly activeModNames: ReadonlySet<string>
  private seq = 0

  constructor(options: PatchEvaluatorOptions) {
    this.activeModNames = options.activeModNames
    this.doc = this.parser.parseFromString('<Defs/>', 'text/xml')
    this.defsRoot = this.doc.documentElement!
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
    for (const ref of sorted) {
      const root = await this.parseXmlRoot(ref, 'Defs')
      if (!root) continue
      for (const child of childElements(root)) {
        const imported = this.doc.importNode(child, true)
        this.defsRoot.appendChild(imported)
        this.nodeSource.set(imported, ref)
        const name = imported.getAttribute('Name')
        if (name) {
          const list = this.nodesByName.get(name) ?? []
          list.push(imported as Element)
          this.nodesByName.set(name, list)
        }
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
      const root = await this.parseXmlRoot(ref, 'Patch')
      if (!root) continue
      for (const opEl of childElements(root)) {
        if (opEl.nodeName !== 'Operation') {
          console.warn(
            `[patch-evaluator] unexpected element in patch XML ${ref.filePath}, expected 'Operation'`,
          )
          continue
        }
        this.applyOperation(opEl, ref.modId, ref.filePath)
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
      const root = await this.parseXmlRoot(ref, 'Patch')
      if (!root) continue
      for (const opEl of childElements(root)) {
        if (opEl.nodeName !== 'Operation') continue
        this.collectMetadata(opEl, ref)
      }
    }
  }

  private collectMetadata(opEl: Element, ref: AssetFileRef): void {
    const xpath = childText(opEl, 'xpath')
    const opClass = normalizeOpClass(opEl.getAttribute('Class'))
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
  private walkNestedOperations(opEl: Element, visit: (el: Element) => void): void {
    // <match>/<nomatch> hold a single PatchOperation; <operations> holds a
    // list where each <li> IS the operation element (Class attr on the li)
    for (const name of ['match', 'nomatch']) {
      const branch = childElement(opEl, name)
      if (branch && branch.getAttribute('Class')) visit(branch)
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
    opEl: Element,
    modId: number,
    filePath: string,
    skipped = false,
  ): boolean {
    const record: PatchOpRecord = {
      modId,
      filePath,
      seq: this.seq++,
      opClass: normalizeOpClass(opEl.getAttribute('Class')),
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
  private applySuccessModifier(opEl: Element, record: PatchOpRecord, raw: boolean): boolean {
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
  private applyWorker(opEl: Element, record: PatchOpRecord): boolean {
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
          `[patch-evaluator] unsupported custom PatchOperation class "${opEl.getAttribute('Class')}" in ${record.filePath}`,
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
  private opAdd(opEl: Element, record: PatchOpRecord): boolean {
    const value = this.requiredValue(opEl, record)
    const prepend = (childText(opEl, 'order') ?? 'Append').toLowerCase() === 'prepend'
    const targets = this.selectAndRecord(opEl, record)
    if (!targets) return false

    for (const target of targets) {
      const imported: Node[] = []
      if (prepend) {
        // game: reverse ChildNodes, PrependChild each — equivalent to
        // inserting each in front of the current first child, reversed
        for (const child of [...childElements(value)].reverse()) {
          imported.push(target.insertBefore(this.doc.importNode(child, true), target.firstChild))
        }
      } else {
        for (const child of childElements(value)) {
          imported.push(target.appendChild(this.doc.importNode(child, true)))
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
  private opInsert(opEl: Element, record: PatchOpRecord): boolean {
    const value = this.requiredValue(opEl, record)
    const append = (childText(opEl, 'order') ?? 'Prepend').toLowerCase() === 'append'
    const targets = this.selectAndRecord(opEl, record)
    if (!targets) return false

    for (const target of targets) {
      const parent = target.parentNode
      if (!parent) continue
      const imported: Node[] = []
      if (append) {
        // game: parentNode.InsertAfter(..., xmlNode) — refChild stays the
        // target, each child lands directly after it (later child first)
        for (const child of childElements(value)) {
          imported.push(parent.insertBefore(this.doc.importNode(child, true), target.nextSibling))
        }
      } else {
        for (const child of [...childElements(value)].reverse()) {
          imported.push(parent.insertBefore(this.doc.importNode(child, true), target))
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
  private opReplace(opEl: Element, record: PatchOpRecord): boolean {
    const value = this.requiredValue(opEl, record)
    const targets = this.selectAndRecord(opEl, record)
    if (!targets) return false

    for (const target of targets) {
      const parent = target.parentNode
      if (!parent) continue
      const imported: Node[] = []
      for (const child of childElements(value)) {
        imported.push(parent.insertBefore(this.doc.importNode(child, true), target))
      }
      parent.removeChild(target)
      this.claimPatchAddedDefs(imported, record)
    }
    return true
  }

  /** PatchOperationRemove */
  private opRemove(opEl: Element, record: PatchOpRecord): boolean {
    const targets = this.selectAndRecord(opEl, record)
    if (!targets) return false
    for (const target of targets) target.parentNode?.removeChild(target)
    return true
  }

  /**
   * PatchOperationAddModExtension: appends `<value>` children into the
   * selected def's `<modExtensions>` container, creating it if absent.
   */
  private opAddModExtension(opEl: Element, record: PatchOpRecord): boolean {
    const value = this.requiredValue(opEl, record)
    const targets = this.selectAndRecord(opEl, record)
    if (!targets) return false

    for (const target of targets) {
      // game: xmlNode["modExtensions"] — first direct child by that name
      let container: Element | null = null
      for (const child of childElements(target)) {
        if (child.nodeName === 'modExtensions') {
          container = child
          break
        }
      }
      if (!container) {
        container = this.doc.createElement('modExtensions')
        target.appendChild(container)
      }
      const imported: Node[] = []
      for (const child of childElements(value)) {
        imported.push(container.appendChild(this.doc.importNode(child, true)))
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
    opEl: Element,
    record: PatchOpRecord,
    kind: 'set' | 'add' | 'remove',
  ): boolean {
    const attribute = childText(opEl, 'attribute')
    if (!attribute) {
      record.status = 'failed'
      return false
    }
    const targets = this.selectAndRecord(opEl, record)
    if (!targets) return false

    let result = false
    for (const target of targets) {
      if (kind === 'set') {
        target.setAttribute(attribute, childText(opEl, 'value') ?? '')
        result = true
      } else if (kind === 'add') {
        if (!target.hasAttribute(attribute)) {
          target.setAttribute(attribute, childText(opEl, 'value') ?? '')
          result = true
        }
      } else if (target.hasAttribute(attribute)) {
        target.removeAttribute(attribute)
        result = true
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
  private opSetName(opEl: Element, record: PatchOpRecord): boolean {
    const name = childText(opEl, 'name')
    if (!name) {
      record.status = 'failed'
      return false
    }
    const targets = this.selectAndRecord(opEl, record)
    if (!targets) return false

    for (const target of targets) {
      const parent = target.parentNode
      if (!parent) continue
      const renamed = this.doc.createElement(name)
      while (target.firstChild) renamed.appendChild(target.firstChild)
      parent.insertBefore(renamed, target)
      parent.removeChild(target)
      // carry the origin over to the renamed node
      const source = this.nodeSource.get(target)
      if (source) this.nodeSource.set(renamed, source)
      const changed = this.changedDefs.get(target)
      if (changed) this.changedDefs.set(renamed, changed)
      this.claimPatchAddedDefs([renamed], record)
    }
    return true
  }

  /**
   * PatchOperationSequence: run operations in order, stop at the first
   * failure — remaining ops are recorded as skipped, never applied.
   */
  private opSequence(opEl: Element, record: PatchOpRecord): boolean {
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
  private opConditional(opEl: Element, record: PatchOpRecord): boolean {
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
  private opFindMod(opEl: Element, record: PatchOpRecord): boolean {
    const modsEl = childElement(opEl, 'mods')
    const names: string[] = []
    if (modsEl) {
      for (const li of childElements(modsEl)) {
        const name = li.textContent?.trim()
        if (name) names.push(name)
      }
    }
    const match = childElement(opEl, 'match')
    const nomatch = childElement(opEl, 'nomatch')

    if (names.some(name => this.activeModNames.has(name))) {
      if (match) return this.applyOperation(match, record.modId, record.filePath)
      return true
    }
    if (nomatch) return this.applyOperation(nomatch, record.modId, record.filePath)
    return true
  }

  /** PatchOperationTest: true iff the xpath selects at least one node. */
  private opTest(opEl: Element, record: PatchOpRecord): boolean {
    const hit = this.selectFirst(record, opEl)
    if (!hit) record.status = 'no-match'
    return hit
  }

  // #endregion

  // #region XPath + bookkeeping helpers

  /**
   * Evaluates the op's xpath. Returns the matched elements with targetDefs
   * backfilled and changedDefs marked, or null on no-match / error.
   */
  private selectAndRecord(opEl: Element, record: PatchOpRecord): Element[] | null {
    const xpath = childText(opEl, 'xpath')
    if (!xpath) {
      record.status = 'failed'
      console.warn(`[patch-evaluator] operation without <xpath> in ${record.filePath}`)
      return null
    }
    record.xpath = xpath
    record.xpathNorm = normalizeXpath(xpath)

    let nodes: Node[]
    try {
      nodes = evaluateXPathToNodes(xpath, this.doc)
    } catch (error) {
      record.status = 'error'
      console.warn(`[patch-evaluator] xpath error in ${record.filePath}: ${error}`)
      return null
    }
    const elements = nodes.filter((n): n is Element => n.nodeType === ELEMENT)
    if (elements.length === 0) {
      record.status = 'no-match'
      return null
    }

    for (const el of elements) {
      const def = this.defAncestorOf(el)
      if (!def) continue
      // concrete defs are identified by defName, abstract templates by @Name
      const defName = directChildText(def, 'defName') ?? def.getAttribute('Name')
      if (!defName) continue
      if (!record.targetDefs.includes(defName)) record.targetDefs.push(defName)

      let changed = this.changedDefs.get(def)
      if (!changed) {
        changed = new Set()
        this.changedDefs.set(def, changed)
      }
      changed.add(record.modId)
    }
    return elements
  }

  /** xpath hit test for Conditional/Test (no targetDefs, no changes marked).
   * Throws on invalid xpath — the caller's catch records status=error. */
  private selectFirst(record: PatchOpRecord, opEl: Element): boolean {
    const xpath = childText(opEl, 'xpath')
    if (!xpath) {
      record.status = 'failed'
      console.warn(`[patch-evaluator] operation without <xpath> in ${record.filePath}`)
      return false
    }
    record.xpath = xpath
    record.xpathNorm = normalizeXpath(xpath)
    return evaluateXPathToFirstNode(xpath, this.doc) !== null
  }

  /** Nearest ancestor-or-self that is a direct child of the unified <Defs>. */
  private defAncestorOf(node: Node): Element | null {
    let current: Node | null = node
    while (current && current !== this.defsRoot) {
      if (current.parentNode === this.defsRoot && current.nodeType === ELEMENT) {
        return current as Element
      }
      current = current.parentNode
    }
    return null
  }

  /**
   * Nodes a patch placed directly under the unified <Defs> are patch-added
   * defs: they get the patch's origin and override everything (§4.2).
   */
  private claimPatchAddedDefs(imported: Node[], record: PatchOpRecord): void {
    for (const node of imported) {
      if (node.parentNode === this.defsRoot && !this.nodeSource.has(node)) {
        this.nodeSource.set(node, {
          filePath: record.filePath,
          modId: record.modId,
          loadOrder: PATCH_DEF_LOAD_ORDER,
        })
      }
    }
  }

  private requiredValue(opEl: Element, record: PatchOpRecord): Element {
    const value = childElement(opEl, 'value')
    if (!value) {
      record.status = 'failed'
      throw new Error(`operation without <value> in ${record.filePath}`)
    }
    return value
  }

  private async parseXmlRoot(ref: AssetFileRef, expectedRoot: string): Promise<Element | null> {
    let text: string
    try {
      text = await readFile(ref.absPath, 'utf8')
    } catch (error) {
      console.warn(`[patch-evaluator] cannot read ${ref.filePath}: ${error}`)
      return null
    }
    let doc: Document
    try {
      doc = this.parser.parseFromString(text, 'text/xml')
    } catch (error) {
      console.warn(`[patch-evaluator] XML parse failed for ${ref.filePath}: ${error}`)
      return null
    }
    const root = doc.documentElement
    if (!root || root.nodeName !== expectedRoot) {
      console.warn(
        `[patch-evaluator] unexpected root element in ${ref.filePath}, expected '${expectedRoot}'`,
      )
      return null
    }
    // game XmlReaderSettings: IgnoreComments = true, IgnoreWhitespace = true
    pruneInsignificantNodes(root)
    return root
  }

  // #endregion

  // #region Serialization (pipeline boundary to the JSON layer)

  serialize(): { defGroups: PatchedDefGroup[]; changedBy: Map<string, number[]> } {
    this.propagateChangedThroughInheritance()

    const groups = new Map<string, PatchedDefGroup & { nodes: Element[] }>()
    const changedBy = new Map<string, number[]>()

    for (const def of childElements(this.defsRoot)) {
      // every node under defsRoot carries a source: set in buildTree,
      // claimPatchAddedDefs, or carried over by opSetName
      const source = this.nodeSource.get(def)!
      const key = `${source.loadOrder}|${source.modId}|${source.filePath}`
      let group = groups.get(key)
      if (!group) {
        group = {
          modId: source.modId,
          loadOrder: source.loadOrder,
          filePath: source.filePath,
          xml: '',
          defNames: [],
          nodes: [],
        }
        groups.set(key, group)
      }
      group.nodes.push(def)

      const defName = directChildText(def, 'defName') ?? def.getAttribute('Name')
      if (!defName) continue
      group.defNames.push(defName)

      const changed = this.changedDefs.get(def)
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
        xml: `<Defs>${group.nodes
          .map(node => this.serializer.serializeToString(node))
          .join('')}</Defs>`,
      })
    }

    return { defGroups, changedBy }
  }

  /**
   * A patch on an abstract template flows into every inheriting def (patch
   * runs BEFORE inheritance resolution, §4.1): propagate changers down the
   * @ParentName edges until a fixpoint, respecting GetBestParentFor's
   * loadOrder <= child constraint.
   */
  private propagateChangedThroughInheritance(): void {
    let changedAny = true
    while (changedAny) {
      changedAny = false
      for (const def of childElements(this.defsRoot)) {
        const own = this.changedDefs.get(def)
        if (own && own.size > 0) continue // already marked; nothing to receive
        const parentName = def.getAttribute('ParentName')
        if (!parentName) continue
        const childLoadOrder = this.nodeSource.get(def)?.loadOrder ?? -1

        const changers = new Set<number>()
        for (const candidate of this.nodesByName.get(parentName) ?? []) {
          if ((this.nodeSource.get(candidate)?.loadOrder ?? -1) > childLoadOrder) {
            continue // parent defined later than the child: not its parent
          }
          for (const modId of this.changedDefs.get(candidate) ?? []) changers.add(modId)
        }
        if (changers.size === 0) continue

        const target = own ?? new Set<number>()
        for (const modId of changers) {
          if (!target.has(modId)) {
            target.add(modId)
            changedAny = true
          }
        }
        this.changedDefs.set(def, target)
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

function childElements(node: Node): Element[] {
  const out: Element[] = []
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === ELEMENT) out.push(child as Element)
  }
  return out
}

function childElement(node: Node, name: string): Element | null {
  return childElements(node).find(child => child.nodeName === name) ?? null
}

function childText(node: Node, name: string): string | null {
  const el = childElement(node, name)
  return el ? el.textContent : null
}

function directChildText(node: Element, name: string): string | null {
  return childElement(node, name)?.textContent?.trim() ?? null
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

/**
 * Removes whitespace-only text nodes and comments, mirroring the game's
 * XmlReaderSettings { IgnoreWhitespace = true, IgnoreComments = true } —
 * otherwise `<value>` child-node sets include indentation noise.
 */
function pruneInsignificantNodes(node: Node): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 8 /* COMMENT */ || child.nodeType === 7 /* PI */) {
      node.removeChild(child)
    } else if (child.nodeType === TEXT && !(child.textContent ?? '').trim()) {
      node.removeChild(child)
    } else if (child.nodeType === ELEMENT) {
      pruneInsignificantNodes(child)
    }
  }
}

// #endregion

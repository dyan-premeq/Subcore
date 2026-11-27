import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { chmodSync, existsSync, statSync, utimesSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncProfile, type SyncOptions } from '../../src/sync/profile'
import { getModByPackageId } from '../../src/repositories/mods-repo'
import { findFilesContaining, findFilesContainingFragment } from '../../src/repositories/source-fts-repo'
import { SCHEMA_VERSION } from '../../src/db/schema'
import { importVanilla } from '../../src/scripts/import-vanilla'
import { SyncStage } from '../../src/utils/sync-stage'
import { rmTemp } from '../helpers/fs'

let temp: string, game: string, dist: string, profile: string, dbPath: string
let options: SyncOptions
let reader: Database | undefined
let configuredRoot: string | undefined
const write = (path: string, body: string) => Bun.write(join(game, path), body)
const about = (id: string, name = id) => write('Mods/' + id + '/About/About.xml',
  '<ModMetaData><packageId>' + id + '</packageId><name>' + name + '</name></ModMetaData>')
const use = (mods: string[], base = 'all-dlc') => Bun.write(profile, JSON.stringify({ name: 'dev', base, autoOrder: false, mods }))
const sync = (extra: SyncOptions = {}) => syncProfile({ ...options, ...extra })
const present = (table: string, defName: string) => Boolean(reader!.query('SELECT 1 FROM ' + table + ' WHERE defName=?').get(defName))
const source = (name: string) => 'public class ' + name + ' { }'
const patchSource = (name: string) =>
  '[HarmonyPatch(typeof(Target), "' + name + '")]\npublic class ' + name + '\n{\n  [HarmonyPrefix]\n  public static void Prefix() {}\n}'
const pack = 'Mods/content.pack'

beforeEach(async () => {
  configuredRoot = process.env.SUBCORE_GAME_ROOT
  delete process.env.SUBCORE_GAME_ROOT
  temp = await mkdtemp(join(tmpdir(), 'subcore-sync-'))
  game = join(temp, 'game')
  dist = join(temp, 'dist')
  profile = join(temp, 'profile.json')
  dbPath = join(dist, 'index.db')
  options = { gameRoot: game, distRoot: dist, profilePath: profile, workshopRoot: join(temp, 'workshop'), ilspyCmd: null }
  await write('Version.txt', '1.7.5014')
  await write('Data/Core/About/About.xml', '<ModMetaData><packageId>ludeon.rimworld</packageId><name>Core</name></ModMetaData>')
  await write('Data/Core/Defs/base.xml', '<Defs><ThingDef Name="Base" Abstract="True"><label>first</label></ThingDef></Defs>')
  await about('content.pack')
  await about('code.only')
  await about('another.mod')
  await write(pack + '/Defs/Thing.xml', '<Defs><ThingDef ParentName="Base"><defName>TestThing</defName></ThingDef></Defs>')
  await write('Mods/code.only/Source/Test.cs', patchSource('OldToken'))
  await write('Mods/another.mod/Source/Keep.cs', patchSource('KeepToken'))
  await use(['content.pack', 'code.only', 'another.mod'])
})

afterEach(async () => {
  if (configuredRoot !== undefined) process.env.SUBCORE_GAME_ROOT = configuredRoot
  reader?.close(true)
  reader = undefined
  await rmTemp(temp)
})

test('reorder, silent same-size edit, removal and reactivation preserve unrelated rows and live FTS vocab', async () => {
  expect((await sync()).mode).toBe('full')
  reader = new Database(dbPath, { readonly: true })
  const codeId = getModByPackageId(reader, 'code.only')!.modId
  const keepId = getModByPackageId(reader, 'another.mod')!.modId
  expect(findFilesContainingFragment(reader, 'oldtoken')).toHaveLength(1)
  const writer = new Database(dbPath)
  // Detect even a DELETE+INSERT that happens to reuse the same rowid.
  writer.run("INSERT INTO csharp_index VALUES ('VanillaMarker','Source/Marker.cs',0,NULL)")
  writer.run("CREATE TRIGGER keep_cs BEFORE DELETE ON csharp_index WHEN OLD.modId IS NULL OR OLD.modId=" + keepId + " BEGIN SELECT RAISE(ABORT,'unrelated C# rewrite'); END")
  writer.run("CREATE TRIGGER keep_harmony BEFORE DELETE ON harmony_patches WHEN OLD.modId=" + keepId + " BEGIN SELECT RAISE(ABORT,'unrelated Harmony rewrite'); END")
  writer.run("CREATE TRIGGER keep_text BEFORE DELETE ON source_files WHEN OLD.path LIKE 'Mods/another.mod/%' BEGIN SELECT RAISE(ABORT,'unrelated FTS rewrite'); END")
  writer.run("CREATE TRIGGER keep_defs BEFORE DELETE ON defs BEGIN SELECT RAISE(ABORT,'unnecessary XML evaluation'); END")
  writer.close(true)
  await write('Mods/code.only/Textures/icon.png', 'irrelevant')
  expect((await sync({ gameRoot: undefined })).status).toBe('up-to-date')
  await use(['code.only', 'content.pack', 'another.mod'])
  expect(await sync()).toMatchObject({ mode: 'incremental', changedMods: [], xmlRebuilt: false })
  expect(reader.query("SELECT loadOrder FROM defs WHERE defName='TestThing'").get()).toEqual({ loadOrder: 2 })

  const path = join(game, 'Mods/code.only/Source/Test.cs')
  const oldTime = statSync(path).mtime
  await Bun.write(path, patchSource('NewToken'))
  utimesSync(path, oldTime, oldTime)
  expect(await sync()).toMatchObject({ changedMods: ['code.only'], xmlRebuilt: false })
  expect(findFilesContainingFragment(reader, 'oldtoken')).toEqual([])
  expect(findFilesContainingFragment(reader, 'newtoken')).toEqual(['Mods/code.only/Source/Test.cs'])
  expect(reader.query("SELECT modId FROM csharp_index WHERE typeName='NewToken'").get()).toEqual({ modId: codeId })

  expect(reader.query('SELECT targetMethod FROM harmony_patches WHERE modId=?').all(codeId)).toEqual([{ targetMethod: 'NewToken' }])
  await use(['content.pack', 'another.mod'])
  expect(await sync()).toMatchObject({ removedMods: ['code.only'], xmlRebuilt: false })
  expect(existsSync(join(dist, 'assets/Mods/code.only'))).toBe(false)
  expect(findFilesContaining(reader, 'NewToken')).toEqual([])
  expect(getModByPackageId(reader, 'code.only')).toMatchObject({ modId: codeId, inProfile: 0 })
  await use(['content.pack', 'another.mod', 'code.only'])
  expect((await sync()).changedMods).toEqual(['code.only'])
  expect(getModByPackageId(reader, 'code.only')!.modId).toBe(codeId)
  await rm(join(game, 'Mods/code.only'), { recursive: true })
  expect((await sync()).removedMods).toEqual(['code.only'])
  expect(getModByPackageId(reader, 'code.only')).toBeNull()
})

test('replays skipped MayRequire predicates, patch-generated requirements and exact FindMod names', async () => {
  await use(['content.pack'])
  await write(pack + '/Defs/Thing.xml', '<Defs><ThingDef MayRequire="CoDe.OnLy|steam"><defName>Gated</defName></ThingDef></Defs>')
  await write(pack + '/Patches/conditional.xml', '<Patch>' +
    '<Operation Class="PatchOperationAdd"><xpath>/Defs</xpath><value><ThingDef MayRequireAnyOf="another.mod,missing"><defName>Added</defName></ThingDef></value></Operation>' +
    '<Operation Class="PatchOperationFindMod"><mods><li>Trigger Name</li></mods><match Class="PatchOperationAdd"><xpath>/Defs</xpath><value><ThingDef><defName>Named</defName></ThingDef></value></match></Operation></Patch>')
  await sync()
  reader = new Database(dbPath, { readonly: true })
  expect(present('defs', 'Gated')).toBe(false)
  await use(['content.pack', 'code.only'])
  expect((await sync()).xmlRebuilt).toBe(true)
  expect(present('defs', 'Gated')).toBe(true)
  expect(present('patched_defs', 'Added')).toBe(false)
  await use(['content.pack', 'code.only', 'another.mod'])
  expect((await sync()).xmlRebuilt).toBe(true)
  expect(present('patched_defs', 'Added')).toBe(true)
  expect(present('patched_defs', 'Named')).toBe(false)
  await about('code.only', 'Trigger Name')
  expect((await sync()).xmlRebuilt).toBe(true)
  expect(present('patched_defs', 'Named')).toBe(true)
})

test('manual order changes XML winners and switching base removes inactive DLC XML', async () => {
  await write('Data/Royalty/About/About.xml', '<ModMetaData><packageId>ludeon.rimworld.royalty</packageId></ModMetaData>')
  await write('Data/Royalty/Defs/Dlc.xml', '<Defs><ThingDef><defName>DlcOnly</defName></ThingDef></Defs>')
  await write('Mods/another.mod/Defs/Other.xml', '<Defs><ThingDef><defName>TestThing</defName><label>second</label></ThingDef></Defs>')
  await write(pack + '/Patches/nothing.xml', '<Patch/>')
  await sync()
  reader = new Database(dbPath, { readonly: true })
  const label = () => reader!.query("SELECT json_extract(payload,'$.label') AS label FROM patched_defs WHERE defName='TestThing'").get()
  expect(label()).toEqual({ label: 'second' })
  expect(present('defs', 'DlcOnly')).toBe(true)
  await use(['another.mod', 'code.only', 'content.pack'], 'core-only')
  expect(await sync()).toMatchObject({ changedMods: [], xmlRebuilt: true })
  expect(label()).toEqual({ label: 'first' })
  expect(present('defs', 'DlcOnly')).toBe(false)
  const indexedData = () => [
    ...['mods', 'defs', 'def_names', 'patch_ops', 'patched_defs', 'csharp_index'].map(table =>
      reader!.query('SELECT * FROM ' + table + ' ORDER BY 1,2,3').all()),
    reader!.query('SELECT modId,filePath,patchClass,targetType,targetMethod,prefix,postfix,transpiler,finalizer FROM harmony_patches ORDER BY 1,2,3').all(),
    reader!.query('SELECT path FROM source_files ORDER BY path').all(),
  ]
  const incremental = indexedData()
  const order = getModByPackageId(reader, 'content.pack')!.modId
  expect((await sync({ full: true })).mode).toBe('full')
  expect(indexedData()).toEqual(incremental)
  expect(getModByPackageId(reader, 'content.pack')!.modId).toBe(order)
  expect(label()).toEqual({ label: 'first' })
})

test('a conditional folder switch selects and decompiles the effective DLL even with an older timestamp', async () => {
  await use(['content.pack'])
  await write(pack + '/LoadFolders.xml', '<loadFolders><v1.7><li>/</li><li IfModActiveAll="code.only,content.pack" IfModNotActive="missing">Compat</li></v1.7></loadFolders>')
  await write(pack + '/Assemblies/Example.dll', source('FirstAssembly'))
  await write(pack + '/Compat/Assemblies/Example.dll', source('OtherAssembly'))
  utimesSync(join(game, pack, 'Compat/Assemblies/Example.dll'), new Date(0), new Date(0))
  const win = process.platform === 'win32'
  const ilspy = join(temp, win ? 'ilspy.cmd' : 'ilspy.sh')
  await Bun.write(ilspy, win
    ? '@echo off\r\nmkdir "%~4" 2>nul\r\ncopy /Y "%~5" "%~4\\%~n5.decompiled.cs" >nul\r\n'
    : '#!/bin/sh\nmkdir -p "$4"\ncp "$5" "$4/Example.decompiled.cs"\n')
  chmodSync(ilspy, 0o755)
  await sync({ ilspyCmd: ilspy })
  reader = new Database(dbPath, { readonly: true })
  const types = () => reader!.query("SELECT typeName FROM csharp_index WHERE filePath LIKE '%Example.decompiled.cs'").all()
  expect(types()).toEqual([{ typeName: 'FirstAssembly' }])
  await use(['content.pack', 'code.only'])
  expect(await sync({ ilspyCmd: ilspy })).toMatchObject({ changedMods: ['content.pack', 'code.only'], xmlRebuilt: true })
  expect(types()).toEqual([{ typeName: 'OtherAssembly' }])
})

test('schema replacement and retries publish consistent snapshots to an existing read-only connection', async () => {
  await use(['content.pack'])
  await sync()
  const writer = new Database(dbPath)
  // A real old-style virtual table cannot delete individual FTS rows.
  writer.run('DROP TABLE source_fts')
  writer.run("CREATE VIRTUAL TABLE source_fts USING fts5(body,content='',detail=none,columnsize=0)")
  writer.run("UPDATE meta SET value='6' WHERE key='schema_version'")
  reader = new Database(dbPath, { readonly: true })
  findFilesContainingFragment(reader, 'testthing')
  expect((await sync()).mode).toBe('full')
  expect(reader.query("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({ value: String(SCHEMA_VERSION) })
  expect(findFilesContainingFragment(reader, 'testthing')).toHaveLength(1)

  const publishedRoot = join(dist, 'assets', pack)
  const originalDirectory = statSync(publishedRoot, { bigint: true }).ino
  const xmlPath = 'Mods/content.pack/Defs/Thing.xml'
  const original = await Bun.file(join(game, xmlPath)).text()
  await write(xmlPath, original.replace('TestThing','NewThing'))
  writer.run("CREATE TRIGGER fail_defs BEFORE INSERT ON defs BEGIN SELECT RAISE(ABORT,'injected failure'); END")
  await expect(sync()).rejects.toThrow('injected failure')
  expect(present('defs','TestThing')).toBe(true)
  expect(await Bun.file(join(dist, 'assets', xmlPath)).text()).toBe(original)
  writer.run('DROP TRIGGER fail_defs')
  writer.close(true)
  const both = await Promise.all([sync(), sync()])
  expect(both.map(r => r.status).sort()).toEqual(['synced', 'up-to-date'])
  expect(present('defs','NewThing')).toBe(true)
  expect(statSync(publishedRoot, { bigint: true }).ino).toBe(originalDirectory)
  expect(findFilesContainingFragment(reader,'testthing')).toEqual([])

  // Simulate the process dying between filesystem publication and SQLite COMMIT.
  const stage = new SyncStage(dist)
  await Bun.write(stage.next('assets/' + xmlPath), 'uncommitted')
  stage.publish('uncommitted-generation')
  expect((await sync()).status).toBe('up-to-date')
  expect(await Bun.file(join(dist, 'assets', xmlPath)).text()).toContain('NewThing')

})

test('only an explicit game-config request replaces the development profile', async () => {
  await write('Data/Royalty/About/About.xml', '<ModMetaData><packageId>ludeon.rimworld.royalty</packageId></ModMetaData>')
  await use(['code.only'])
  const original = await Bun.file(profile).text()
  await write('ModsConfig.xml', '<ModsConfigData><activeMods><li>ludeon.rimworld</li><li>content.pack</li></activeMods></ModsConfigData>')
  await sync()
  expect(await Bun.file(profile).text()).toBe(original)
  const opts = { fromGameConfig: true, modsConfigPath: join(game, 'ModsConfig.xml') }
  expect(await sync(opts)).toMatchObject({ removedMods: ['code.only'], changedMods: ['content.pack'] })
  expect(await Bun.file(profile).json()).toMatchObject({ base: 'core-only', mods: ['content.pack'] })
  expect((await sync(opts)).status).toBe('up-to-date')
  const saved = await Bun.file(profile).text()
  await write('ModsConfig.xml', '<broken>')
  await expect(sync(opts)).rejects.toThrow('ModsConfig.xml')
  expect(await Bun.file(profile).text()).toBe(saved)
})

test('a standalone vanilla import supplies the installation path for first sync', async () => {
  importVanilla({ gameRoot: game, distRoot: dist, ilspyCmd: null })
  expect((await sync({ gameRoot: undefined })).mode).toBe('full')
  expect((await sync({ gameRoot: undefined })).status).toBe('up-to-date')
})

test('nested requirements and silent vanilla XML updates invalidate the XML layer', async () => {
  await write(pack + '/Defs/Thing.xml', '<Defs><ThingDef ParentName="Base"><defName>TestThing</defName><comps><li MayRequire="code.only">X</li></comps></ThingDef></Defs>')
  await use(['content.pack'])
  await sync()
  await use(['content.pack', 'code.only'])
  expect((await sync()).xmlRebuilt).toBe(true)
  await write('Data/Core/Defs/base.xml', '<Defs><ThingDef Name="Base" Abstract="True"><label>other</label></ThingDef></Defs>')
  expect(await sync()).toMatchObject({ changedMods: [], xmlRebuilt: true })
  reader = new Database(dbPath, { readonly: true })
  expect(reader.query("SELECT label FROM defs WHERE defName='TestThing'").get()).toEqual({ label: 'other' })
})

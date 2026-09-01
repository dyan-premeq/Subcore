import { describe, expect, test } from 'bun:test'
import { extractHarmonyPatches } from '../../src/utils/harmony-parse'

describe('harmony-parse', () => {
  test('full attribute: typeof + method string + postfix flag', () => {
    const records = extractHarmonyPatches(`using HarmonyLib;

[HarmonyPatch(typeof(Pawn_InventoryTracker), "Notify_ItemRemoved")]
public static class Pawn_InventoryTracker_Notify_ItemRemoved_Patch
{
    [HarmonyPostfix]
    public static void Postfix(Pawn_InventoryTracker __instance)
    {
    }
}`)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      patchClass: 'Pawn_InventoryTracker_Notify_ItemRemoved_Patch',
      targetType: 'Pawn_InventoryTracker',
      targetMethod: 'Notify_ItemRemoved',
      prefix: false,
      postfix: true,
      transpiler: false,
      finalizer: false,
    })
  })

  test('stacked attributes merge (type attr + method attr)', () => {
    const records = extractHarmonyPatches(
      `[HarmonyPatch(typeof(ITab_Pawn_Gear))]\n[HarmonyPatch("FillTab")]\npublic class ITab_Pawn_Gear_FillTab_Patch\n{\n    [HarmonyTranspiler]\n    static IEnumerable<CodeInstruction> Transpiler() { yield break; }\n}`,
    )
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      patchClass: 'ITab_Pawn_Gear_FillTab_Patch',
      targetType: 'ITab_Pawn_Gear',
      targetMethod: 'FillTab',
      transpiler: true,
    })
  })

  test('nameof(...) resolves statically to the last identifier', () => {
    const records = extractHarmonyPatches(
      `[HarmonyPatch(typeof(FoodUtility), nameof(FoodUtility.BestFoodSourceOnMap))]\nstatic class P\n{\n    [HarmonyPrefix]\n    static void Prefix() { }\n}`,
    )
    expect(records[0]).toMatchObject({
      targetType: 'FoodUtility',
      targetMethod: 'BestFoodSourceOnMap',
      prefix: true,
    })
  })

  test('bare [HarmonyPatch] records dynamic', () => {
    const records = extractHarmonyPatches(
      `[HarmonyPatch]\npublic static class RuntimePatches\n{\n    static IEnumerable<MethodBase> TargetMethods() { yield break; }\n}`,
    )
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      patchClass: 'RuntimePatches',
      targetType: 'dynamic',
      targetMethod: null,
    })
  })

  test('PatchAll() call yields one *Assembly* marker row with the calling class', () => {
    const records = extractHarmonyPatches(`public class ModEntry\n{\n    public static void Startup()\n    {\n        var harmony = new Harmony("com.example.mod");\n        harmony.PatchAll();\n    }\n}`)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      patchClass: 'ModEntry',
      targetType: '*Assembly*',
      targetMethod: null,
    })
  })

  test('manual AccessTools.Method targets are recorded once each', () => {
    const records = extractHarmonyPatches(
      `internal static class HarmonyPatches\n{\n    static HarmonyPatches()\n    {\n        var val = new Harmony("x");\n        val.Patch(AccessTools.Method(typeof(PawnUtility), "CanPickUp"), null, null, null, null);\n        val.Patch(AccessTools.Method(typeof(PawnUtility), "CanPickUp"), null, null, null, null);\n        val.Patch(AccessTools.Method(typeof(JobDriver_HaulToCell), "MakeNewToils"), null, null, null, null);\n    }\n}`,
    )
    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({
      patchClass: 'HarmonyPatches',
      targetType: 'PawnUtility',
      targetMethod: 'CanPickUp',
    })
    expect(records[1]).toMatchObject({
      targetType: 'JobDriver_HaulToCell',
      targetMethod: 'MakeNewToils',
    })
  })

  test('AccessTools.Method without any .Patch( call is ignored', () => {
    const records = extractHarmonyPatches(
      `public class Helper\n{\n    public static void M() { var mi = AccessTools.Method(typeof(Foo), "Bar"); }\n}`,
    )
    expect(records).toHaveLength(0)
  })

  test('Harmony naming convention: kind inferred from method name (VEF shape, nested class)', () => {
    const records = extractHarmonyPatches(
      `[HarmonyPatch(typeof(PawnUtility))]
[HarmonyPatch("Mated")]
public static class VanillaExpandedFramework_PawnUtility_Mated_Patch
{
    public static bool Prefix(Pawn male, Pawn female)
    {
        return true;
    }
}`,
    )
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      patchClass: 'VanillaExpandedFramework_PawnUtility_Mated_Patch',
      targetType: 'PawnUtility',
      targetMethod: 'Mated',
      prefix: true,
      postfix: false,
    })
  })

  test('plain source produces nothing', () => {
    expect(extractHarmonyPatches('public class Plain\n{\n}\n')).toHaveLength(0)
  })

  test('attributes belonging to a non-Harmony class are not misparsed', () => {
    const records = extractHarmonyPatches(
      `[Obsolete]\npublic class Old\n{\n}\n\n[HarmonyPatch(typeof(A), "B")]\npublic class Real\n{\n}`,
    )
    expect(records).toHaveLength(1)
    expect(records[0].patchClass).toBe('Real')
  })
})

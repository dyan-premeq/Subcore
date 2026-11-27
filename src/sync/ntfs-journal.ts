import { dlopen, FFIType } from 'bun:ffi'
import { lstatSync, statSync } from 'node:fs'
import { parse } from 'node:path'

// Optional fast path across separate CLI processes. Reads the existing NTFS change
// journal with FILE_TRAVERSE; an unavailable or rolled-over journal requires a scan.
const { ptr, u32, i32, i64 } = FFIType
const win = dlopen('kernel32.dll', {
  CreateFileW: { args: [ptr, u32, u32, ptr, u32, u32, ptr], returns: i64 },
  CloseHandle: { args: [i64], returns: i32 },
  DeviceIoControl: { args: [i64, u32, ptr, u32, ptr, u32, ptr, ptr], returns: i32 },
  GetVolumeInformationW: { args: [ptr, ptr, u32, ptr, ptr, ptr, ptr, u32], returns: i32 },
}).symbols

export interface JournalSnapshot {
  volume: string
  journalId: string
  cursor: string
  roots: string[]
  watched: Record<string, string[]>
}

export function openJournal(roots: string[]) {
  const drive = parse(roots[0]).root.toUpperCase()
  if (!/^[A-Z]:\\$/.test(drive) || roots.some(p => parse(p).root.toUpperCase() !== drive)) return
  const wide = (s: string) => Buffer.from(s + '\0', 'utf16le')
  const fsName = Buffer.alloc(32)
  if (!win.GetVolumeInformationW(wide(drive), null, 0, null, null, null, fsName, 16) ||
      fsName.toString('utf16le').split('\0')[0] !== 'NTFS') return

  const handle = win.CreateFileW(wide('\\\\.\\' + drive.slice(0, 2)), 0x20, 7, null, 3, 0, null)
  if (handle === -1n) return
  const bytes = Buffer.alloc(4)
  const control = (code: number, input: Buffer | null, out: Buffer) =>
    win.DeviceIoControl(handle, code, input, input?.length ?? 0, out, out.length, bytes, null)
  const info = Buffer.alloc(80)
  if (!control(0x900f4, null, info)) { // FSCTL_QUERY_USN_JOURNAL
    win.CloseHandle(handle)
    return
  }

  const journalId = info.readBigUInt64LE(0)
  const first = info.readBigInt64LE(8)
  const next = info.readBigInt64LE(16)
  const volume = statSync(drive, { bigint: true }).dev
  const rootIds = roots.map(path => {
    const s = statSync(path, { bigint: true, throwIfNoEntry: false })
    return JSON.stringify([path, s?.dev.toString(), s?.ino.toString()])
  })
  return {
    close: () => win.CloseHandle(handle),
    cursor: next.toString(),
    capture(paths: Map<string, Set<string>>, reuse: Record<string, string[]>): JournalSnapshot | undefined {
      const watched = { ...reuse }
      for (const [scope, files] of paths) {
        const ids = new Set<string>()
        for (const path of files) {
          const s = lstatSync(path, { bigint: true, throwIfNoEntry: false })
          // Reparse points and other volumes need their own journal.
          if (!s || s.dev !== volume || s.isSymbolicLink() || !s.ino) return
          ids.add(s.ino.toString())
        }
        watched[scope] = [...ids]
      }
      return { volume: drive, journalId: String(journalId), cursor: String(next), roots: rootIds, watched }
    },
    /** Undefined means the journal cannot account for the whole interval. */
    changes(previous: JournalSnapshot): Set<string> | undefined {
      if (previous.volume !== drive || previous.journalId !== String(journalId) ||
          JSON.stringify(rootIds) !== JSON.stringify(previous.roots)) return
      let cursor = BigInt(previous.cursor)
      if (cursor < first || cursor > next) return
      const touched = new Set<string>()
      const input = Buffer.alloc(48) // READ_USN_JOURNAL_DATA_V1
      input.writeUInt32LE(0xffffffff, 8)
      input.writeBigUInt64LE(journalId, 32)
      input.writeUInt16LE(2, 40)
      input.writeUInt16LE(3, 42)
      const out = Buffer.alloc(65536)
      while (cursor < next) {
        input.writeBigInt64LE(cursor)
        if (!control(0x903ab, input, out)) return // FSCTL_READ_UNPRIVILEGED_USN_JOURNAL
        const end = bytes.readUInt32LE()
        if (end < 8 || out.readBigInt64LE(0) <= cursor) return
        for (let i = 8; i < end;) {
          const size = out.readUInt32LE(i)
          const version = out.readUInt16LE(i + 4)
          if ((version !== 2 && version !== 3) || size < (version === 2 ? 60 : 76) || i + size > end) return
          // NTFS file reference numbers are 64 bits, including in 128-bit V3 fields.
          const file = out.readBigUInt64LE(i + 8)
          const parent = out.readBigUInt64LE(i + (version === 2 ? 16 : 24))
          touched.add(String(file))
          touched.add(String(parent))
          i += size
        }
        cursor = out.readBigInt64LE(0)
      }
      const dirty = new Set<string>()
      for (const [scope, ids] of Object.entries(previous.watched)) {
        if (ids.some(id => touched.has(id))) dirty.add(scope)
      }
      return dirty
    },
  }
}

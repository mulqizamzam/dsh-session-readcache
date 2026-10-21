// REPRO: a `session/disposed` event makes the NEXT list() call wait for a full
// directory scan.
//
// Mechanism under test (lib/index.js):
//   ctx.on('session/disposed', ...) -> listCache = undefined
// A dispose is a ONE-ROW event. The memo it invalidates is a WHOLE-LIST memo,
// and refilling it means the host's list() runs again: measured on this host
// at 3.3 s warm and 77.7 s cold over its 4,016-log corpus. The next caller
// pays that scan in full.
//
// What the host's own list() returns is DISK-based (packages/session/
// session-persistence-jsonl: listArtifacts walks the session directories), so
// a detached session that was materialized is still listed by the host. The
// rescan therefore reproduces, in the common case, the very list the memo
// already held.
//
// Usage: node artifacts/perf/repro-dispose-stall.mjs [libPath] [scanMs]
// Exit 0 = no stall (fixed). Exit 1 = the stall is present (bug).
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'

const LIB = process.argv[2] ?? new URL('../lib/index.js', import.meta.url).pathname
const SCAN_MS = Number(process.argv[3] ?? 300)

const { apply } = await import(LIB)

// HERMETIC: without this the plugin resolves the DEFAULT snapshot path from
// DSH_HOME, so the script would read and write the live host's snapshot file.
delete process.env.DSH_HOME

const dir = mkdtempSync(join(tmpdir(), 'rc-repro-'))
const snapshots = [
  { header: { id: 's1', cwd: '/p1', createdAt: 1 }, revision: 'r1', sizeBytes: 10 },
  { header: { id: 's2', cwd: '/p1', createdAt: 2 }, revision: 'r2', sizeBytes: 20 },
]

let scans = 0
const service = {
  async list() {
    scans += 1
    await new Promise((r) => setTimeout(r, SCAN_MS))
    return snapshots.map((s) => ({ ...s, header: { ...s.header } }))
  },
}

const listeners = new Map()
const ctx = {
  inject: (names, cb) => cb({ sessionPersistence: service, sessions: { get: () => undefined } }),
  effect: (fn) => fn(),
  logger: { info: () => {}, warn: () => {} },
  on: (event, cb) => { const l = listeners.get(event) ?? []; l.push(cb); listeners.set(event, l) },
  webServer: { register: () => () => {} },
}
apply(ctx, { snapshotPath: undefined })

// 1. Warm the memo with one scan.
const warmStart = performance.now()
await service.list()
const warmMs = performance.now() - warmStart

// 2. One session is disposed. Nothing about the other sessions changed.
for (const cb of listeners.get('session/disposed') ?? []) cb({ id: 's2' })

// 3. The next caller asks for the list. This is the call the dispose made slow.
const afterStart = performance.now()
const rows = await service.list()
const afterMs = performance.now() - afterStart

// 4. The memo must still be able to answer: the reply is the same list.
const ok = rows.length === snapshots.length

// The stall: the caller waited for a scan it did not need.
const stalled = afterMs > SCAN_MS / 2

console.log(`warm list()            : ${warmMs.toFixed(1)} ms (one scan, ${SCAN_MS} ms)`)
console.log(`list() after a dispose : ${afterMs.toFixed(1)} ms  (scans so far: ${scans})`)
console.log(`reply correct          : ${ok}`)

if (!ok) {
  console.log('\nFAIL: the reply lost rows')
  rmSync(dir, { recursive: true, force: true })
  process.exit(1)
}

if (stalled) {
  console.log(`\nFAIL: a dispose made the next list() wait ${afterMs.toFixed(1)} ms for a scan`)
  console.log('      (the list itself did not change: the host lists disposed-but-materialized')
  console.log('       sessions from disk, so the rescan reproduces the memo it just threw away)')
  rmSync(dir, { recursive: true, force: true })
  process.exit(1)
}

console.log('\nPASS: the next list() after a dispose was answered from memory')
rmSync(dir, { recursive: true, force: true })
process.exit(0)

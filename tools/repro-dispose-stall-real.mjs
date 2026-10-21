// The same repro as repro-dispose-stall.mjs, against the REAL session corpus
// on this host, using the host's own serial zstd header scan as the service
// (the same stand-in artifacts/verify-slowscan.mjs uses).
//
// Run: node --import <tsx-loader> artifacts/perf/repro-dispose-stall-real.mjs
// Exit 0 = no stall (fixed). Exit 1 = the stall is present (bug).
import { readdir, stat } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'
import { open } from 'node:fs/promises'
import { apply } from '../lib/index.js'
import { scanZstdFrames, decompressZstdFrame } from '/home/administrator/deepseek-harness/packages/session/session-persistence-jsonl/src/zstd.ts'

// HERMETIC: without this the plugin resolves the DEFAULT snapshot path from
// DSH_HOME, so the script would read and write the live host's snapshot file.
delete process.env.DSH_HOME

const ROOT = '/home/administrator/agent-workspace/.dsh/sessions'

async function corpusFiles() {
  const out = []
  for (const project of await readdir(ROOT, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const pdir = join(ROOT, project.name)
    for (const sd of await readdir(pdir, { withFileTypes: true })) {
      if (!sd.isDirectory()) continue
      const path = join(pdir, sd.name, 'session.jsonl.zstd')
      try { if ((await stat(path)).size > 0) out.push(path) } catch { /* no log */ }
    }
  }
  return out
}

// The host's shape: {header, revision, sizeBytes}. Serial, one zstd header
// frame per log, the cost the live RPC pays.
function makeService(files) {
  let listCalls = 0
  return {
    get listCalls() { return listCalls },
    async list() {
      listCalls += 1
      const out = []
      for (const path of files) {
        const handle = await open(path, 'r')
        try {
          const chunk = Buffer.alloc(131072)
          const { bytesRead } = await handle.read(chunk, 0, chunk.length, 0)
          const first = scanZstdFrames(chunk.subarray(0, bytesRead), 1).frames[0]
          if (first === undefined) continue
          const plain = await decompressZstdFrame(chunk.subarray(first.start, first.end))
          const header = JSON.parse(plain.toString('utf8'))
          out.push({ header, revision: 'r', sizeBytes: bytesRead })
        } catch { /* unreadable log: the host skips it too */ } finally {
          await handle.close()
        }
      }
      return out
    },
  }
}

const files = await corpusFiles()
console.log(`corpus: ${files.length} session logs under ${ROOT}`)

const svc = makeService(files)
const listeners = new Map()
const ctx = {
  inject: (names, cb) => cb({ sessionPersistence: svc, sessions: { get: () => undefined } }),
  effect: (fn) => fn(),
  logger: { info: () => {}, warn: () => {} },
  on: (event, cb) => { const l = listeners.get(event) ?? []; l.push(cb); listeners.set(event, l) },
  webServer: { register: () => () => {} },
}
apply(ctx, { snapshotPath: undefined })

const warmStart = performance.now()
const warm = await svc.list()
const warmMs = performance.now() - warmStart
console.log(`warm list()            : ${warmMs.toFixed(0)} ms (${warm.length} headers)`)

// One session is disposed. Nothing else changed.
const first = warm[0]?.header?.id
for (const cb of listeners.get('session/disposed') ?? []) cb({ id: first })

const afterStart = performance.now()
const rows = await svc.list()
const afterMs = performance.now() - afterStart
console.log(`list() after a dispose : ${afterMs.toFixed(0)} ms  (scans so far: ${svc.listCalls})`)
console.log(`reply correct          : ${rows.length === warm.length}`)

if (rows.length !== warm.length) {
  console.log('\nFAIL: the reply lost rows')
  process.exit(1)
}
if (afterMs > warmMs / 2) {
  console.log(`\nFAIL: a dispose made the next list() wait ${afterMs.toFixed(0)} ms for a scan`)
  console.log('      (the list itself did not change: the host lists disposed-but-materialized')
  console.log('       sessions from disk, so the rescan reproduces the memo it just threw away)')
  process.exit(1)
}
console.log('\nPASS: the next list() after a dispose was answered from memory')
process.exit(0)

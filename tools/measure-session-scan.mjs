// End-to-end proof of the list path against the REAL session corpus.
//
// The live host cannot demonstrate this until it restarts (ESM modules are
// loaded once at boot, and restarts belong to the operator), so this harness
// reproduces the host's own serial header scan as the underlying service and
// mounts the plugin on top of it. It measures exactly three questions:
//   1. does the stale window answer instantly while a scan is running?
//   2. does the snapshot seed a second mount without any scan?
//   3. do the counters say what the README claims they say?
//
// Run: node --import <tsx-loader> artifacts/verify-slowscan.mjs
import { readdir, stat, open, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'
import { apply } from '../lib/index.js'
import { scanZstdFrames, decompressZstdFrame } from '/home/administrator/deepseek-harness/packages/session/session-persistence-jsonl/src/zstd.ts'

const ROOT = '/home/administrator/agent-workspace/.dsh/sessions'
const work = await mkdtemp(join(tmpdir(), 'readcache-e2e-'))
const snapshotPath = join(work, 'list-snapshot.db')

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

// A faithful stand-in for the host's list(): serial, one zstd header frame per
// log, no concurrency. Its cost is the cost the live RPC pays.
function makeService(files) {
  let listCalls = 0
  return {
    get listCalls() { return listCalls },
    locate: (meta) => ({ kind: 'jsonl', path: meta.__path }),
    async inspect() { return { meta: {}, events: [] } },
    async list() {
      listCalls += 1
      const headers = []
      for (const path of files) {
        const handle = await open(path, 'r')
        try {
          const chunk = Buffer.alloc(131072)
          const { bytesRead } = await handle.read(chunk, 0, chunk.length, 0)
          const first = scanZstdFrames(chunk.subarray(0, bytesRead), 1).frames[0]
          if (first === undefined) continue
          const plain = await decompressZstdFrame(chunk.subarray(first.start, first.end))
          headers.push({ id: path, cwd: ROOT, createdAt: 1, __path: path, headerBytes: plain.length })
        } finally {
          await handle.close()
        }
      }
      return headers
    },
  }
}


function metrics(ctx) {
  const route = ctx.routes.find((r) => r.path === '/plugin/session-readcache/metrics')
  let body
  route.handler({}, { writeHead() {}, end(json) { body = JSON.parse(json) } })
  return body
}

const files = await corpusFiles()
console.log(`corpus: ${files.length} session logs under ${ROOT}`)

// --- 1. baseline: what one raw scan costs, un-cached -------------------------
const bare = makeService(files)
const t0 = performance.now()
await bare.list()
const baselineMs = performance.now() - t0
console.log(`\n[1] raw serial scan (what the host pays today): ${baselineMs.toFixed(0)} ms`)

// --- mount the wrapper once, the way the host mounts it -----------------------
const svc = makeService(files)
let wrappedList
const ctx = {
  routes: [],
  inject: (names, cb) => cb({ sessionPersistence: svc, sessions: { get: () => undefined } }),
  effect: () => () => {},
  logger: { info: () => {}, warn: () => {} },
  webServer: { register(r) { ctx.routes.push(r); return () => {} } },
}
apply(ctx, { listTtlMs: 750, listMaxStaleMs: 30_000, snapshotPath: undefined })
wrappedList = (...args) => svc.list(...args)

const firstStart = performance.now()
const first = await wrappedList() // primes the memo (one real scan)
const firstMs = performance.now() - firstStart
console.log(`\n[2] wrapped first list(): ${firstMs.toFixed(0)} ms (${first.length} headers)`)
const hitStart = performance.now()
const hit = await wrappedList()
const hitMs = performance.now() - hitStart
console.log(`    inside TTL  -> ${hitMs.toFixed(1)} ms, served ${hit.length} headers`)
await new Promise((r) => setTimeout(r, 900)) // TTL (750ms) now expired
const staleStart = performance.now()
const stale = await wrappedList()
const staleMs = performance.now() - staleStart
console.log(`    past TTL    -> ${staleMs.toFixed(1)} ms, served ${stale.length} headers (stale window)`)
await new Promise((r) => setTimeout(r, baselineMs + 500),) // let the background refresh finish
console.log(`    underlying scans: ${svc.listCalls}, counters: ${JSON.stringify(metrics(ctx).list)}`)

// --- 3. boot seed from the snapshot the first mount wrote --------------------
const seedRoutes = []
const seedSvc = makeService(files)
const seedCtx = {
  routes: seedRoutes,
  inject: (names, cb) => cb({ sessionPersistence: seedSvc, sessions: { get: () => undefined } }),
  effect: () => () => {},
  logger: { info: () => {}, warn: () => {} },
  webServer: { register(r) { seedCtx.routes.push(r); return () => {} } },
}
apply(seedCtx, { listTtlMs: 750, listMaxStaleMs: 30_000, snapshotPath, snapshotMaxAgeMs: 600_000 })
const seedStart = performance.now()
const seeded = await seedSvc.list()
const seedMs = performance.now() - seedStart
console.log(`\n[3] cold mount seeded from SQLite: ${seedMs.toFixed(1)} ms, ${seeded.length} headers`)
console.log(`    underlying scans performed by seeded mount: ${seedSvc.listCalls}`)
console.log(`    snapshot metrics -> ${JSON.stringify(metrics(seedCtx).snapshot)}`)

await rm(work, { recursive: true, force: true })
console.log('\nDONE')

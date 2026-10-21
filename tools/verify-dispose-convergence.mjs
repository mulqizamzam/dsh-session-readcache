// VERIFY: after a dispose the memo is served from memory AND still converges
// to the host's truth. A fix that only made the reply fast but stopped the
// refresh would leave the memo permanently stale.
//
// Usage: node artifacts/perf/verify-dispose-convergence.mjs [libPath]
import { performance } from 'node:perf_hooks'

const LIB = process.argv[2] ?? new URL('../lib/index.js', import.meta.url).pathname
const { apply } = await import(LIB)

// HERMETIC: without this the plugin resolves the DEFAULT snapshot path from
// DSH_HOME, so the script would read and write the live host's snapshot file.
delete process.env.DSH_HOME

const SCAN_MS = 120
let scans = 0
let hostList = [{ header: { id: 's1', cwd: '/p', createdAt: 1 }, revision: 'r1', sizeBytes: 1 }]

const service = {
  async list() {
    scans += 1
    await new Promise((r) => setTimeout(r, SCAN_MS))
    return hostList.map((s) => ({ ...s, header: { ...s.header } }))
  },
}

const listeners = new Map()
const routes = []
const ctx = {
  inject: (names, cb) => cb({ sessionPersistence: service, sessions: { get: () => undefined } }),
  effect: (fn) => fn(),
  logger: { info: () => {}, warn: () => {} },
  on: (event, cb) => { const l = listeners.get(event) ?? []; l.push(cb); listeners.set(event, l) },
  webServer: { register: (r) => { routes.push(r); return () => {} } },
}
apply(ctx, { snapshotPath: undefined })

const metrics = () => {
  let body
  routes.find((r) => r.path === '/plugin/session-readcache/metrics')
    .handler({}, { writeHead() {}, end(json) { body = JSON.parse(json) } })
  return body
}

const checks = []
const check = (label, ok, detail = '') => {
  checks.push(ok)
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `, ${detail}` : ''}`)
}

// 1. Warm the memo.
await service.list()
check('memo warm after a scan', metrics().memo.warm === true)

// 2. A session is disposed.
for (const cb of listeners.get('session/disposed') ?? []) cb({ id: 's1' })
check('the dispose is counted', metrics().lifecycle.disposedInvalidations === 1,
  `disposedInvalidations=${metrics().lifecycle.disposedInvalidations}`)

// 3. The next caller is served from memory.
const t0 = performance.now()
const rows = await service.list()
const served = performance.now() - t0
check('the next list() did not wait for a scan', served < SCAN_MS / 2, `${served.toFixed(1)} ms`)
check('the reply still carries every row', rows.length === 1)

// 4. The refresh behind it must run and install the host's truth.
await new Promise((r) => setTimeout(r, SCAN_MS * 3))
check('a refresh scan ran behind the reply', scans === 2, `scans=${scans}`)
check('the memo is warm again', metrics().memo.warm === true)

// 5. After the refresh the memo is FRESH: a call inside the TTL is a hit,
//    not a stale serve. That is what proves the dirty flag was cleared.
const before = metrics().list
await service.list()
const after = metrics().list
check('the memo is served fresh again (dirty flag cleared)',
  after.hits === before.hits + 1 && after.staleServed === before.staleServed,
  `hits ${before.hits}->${after.hits}, staleServed ${before.staleServed}->${after.staleServed}`)

// 6. The host's truth changed while the refresh was running: the memo must
//    carry the NEW list, not the old one.
hostList = [
  { header: { id: 's1', cwd: '/p', createdAt: 1 }, revision: 'r1', sizeBytes: 1 },
  { header: { id: 's2', cwd: '/p', createdAt: 2 }, revision: 'r2', sizeBytes: 2 },
]
for (const cb of listeners.get('session/disposed') ?? []) cb({ id: 's2' })
await service.list()
await new Promise((r) => setTimeout(r, SCAN_MS * 3))
const final = await service.list()
check('the memo converged to the host truth', final.length === 2, `${final.length} rows`)

const failed = checks.filter((ok) => !ok).length
console.log(`\n${checks.length - failed}/${checks.length} checks pass`)
process.exit(failed === 0 ? 0 : 1)

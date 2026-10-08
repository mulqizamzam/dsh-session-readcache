import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, appendFileSync, statSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { apply } from '../lib/index.js'


/**
 * Read the snapshot row straight out of the file, or undefined when the file or
 * row is absent. Used to prove a declined write really left nothing behind.
 */
function dbRow(snapshotPath) {
  if (!existsSync(snapshotPath)) return undefined
  const require = createRequire(import.meta.url)
  const Database = require('better-sqlite3')
  const db = new Database(snapshotPath, { readonly: true, fileMustExist: true })
  try {
    return db.prepare('SELECT saved_at, headers FROM readcache_list_snapshot WHERE id = 1').get()
  } catch {
    return undefined // table not created means no write ever landed
  } finally {
    db.close()
  }
}

function makeFake({ listDelayMs = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'readcache-'))
  const calls = { inspect: 0, list: 0 }
  const live = new Set()
  const paths = {}
  const headers = []
  for (const id of ['s1', 's2', 's3', 's4']) {
    paths[id] = join(dir, id)
    writeFileSync(paths[id], 'x')
    headers.push({ id, cwd: '/p1', createdAt: 1 })
  }
  const service = {
    get inspectCalls() { return calls.inspect },
    get listCalls() { return calls.list },
    locate: (meta) => ({ kind: 'fake', path: paths[meta.id] ?? `<missing:${meta.id}>` }),
    async inspect(id) {
      calls.inspect += 1
      if (listDelayMs) await new Promise((r) => setTimeout(r, listDelayMs))
      if (paths[id] === undefined) throw new Error(`not found: ${id}`)
      return { meta: headers.find((h) => h.id === id), events: [{ seq: 0, type: 'x' }] }
    },
    async list(signal) {
      calls.list += 1
      if (listDelayMs) await new Promise((r) => setTimeout(r, listDelayMs))
      if (signal?.aborted) throw new Error('aborted')
      return headers.map((h) => ({ ...h }))
    },
  }
  const ctx = {
    inject: (names, cb) => cb({ sessionPersistence: service, sessions: { get: (id) => (live.has(id) ? {} : undefined) } }),
    effect: (fn) => fn(),
    logger: { info: () => {}, warn: () => {} },
    webServer: {
      _registeredRoutes: [],
      register(route) {
        this._registeredRoutes.push(route)
        return () => {
          const i = this._registeredRoutes.indexOf(route)
          if (i >= 0) this._registeredRoutes.splice(i, 1)
        }
      },
    },
  }
  return { ctx, service, live, paths, dir }
}

const tests = []
function test(label, fn) { tests.push([label, fn]) }

/** Plant a snapshot row directly, bypassing the plugin's own write path. */
function plantSnapshot(snapshotPath, headers, savedAt = Date.now()) {
  const Database = createRequire(import.meta.url)('better-sqlite3')
  const db = new Database(snapshotPath)
  db.exec(`CREATE TABLE IF NOT EXISTS readcache_list_snapshot (
    id INTEGER PRIMARY KEY CHECK (id = 1), saved_at INTEGER NOT NULL, headers TEXT NOT NULL)`)
  db.prepare('INSERT OR REPLACE INTO readcache_list_snapshot VALUES (1, ?, ?)').run(savedAt, JSON.stringify(headers))
  db.close()
}

/** Mount the plugin over a fake service and expose the metrics snapshot. */
function mountSnapshot(pluginConfig, serviceHeaders) {
  const headers = serviceHeaders ?? [{ id: 's1', cwd: '/p1', createdAt: 1 }]
  let listCalls = 0
  const service = {
    locate: (meta) => ({ kind: 'fake', path: '/x/' + String(meta?.id) }),
    async inspect() { return { meta: {}, events: [] } },
    async list() { listCalls += 1; return headers.map((h) => ({ ...h })) },
  }
  const routes = []
  const ctx = {
    inject: (names, cb) => cb({ sessionPersistence: service, sessions: { get: () => undefined } }),
    effect: (fn) => fn(),
    logger: { info: () => {}, warn: () => {} },
    webServer: { register(r) { routes.push(r); return () => {} } },
  }
  apply(ctx, pluginConfig)
  const snapshot = () => {
    let body
    routes.find((r) => r.path === '/plugin/session-readcache/metrics')
      .handler({}, { writeHead() {}, end(json) { body = JSON.parse(json) } })
    return body.snapshot
  }
  return { service, snapshot, calls: () => listCalls }
}

test('snapshot: rows that are not session headers are refused, not served', async () => {
  for (const payload of [[1, 2, null], [{ id: 'ok', cwd: '/p' }, null], [{ cwd: '/p' }], ['a-string']]) {
    const dir = mkdtempSync(join(tmpdir(), 'readcache-shape-'))
    const snapPath = join(dir, 's.db')
    plantSnapshot(snapPath, payload)
    const m = mountSnapshot({ snapshotPath: snapPath, snapshotMaxAgeMs: 600_000, listTtlMs: 750 })
    const served = await m.service.list()
    assert.equal(served[0]?.id, 's1', `payload ${JSON.stringify(payload)} must not be served as a session row`)
    assert.equal(m.calls(), 1, `payload ${JSON.stringify(payload)} must fall back to a real scan`)
    assert.ok(
      m.snapshot().notes.some((note) => note.includes('not session headers')),
      'the refusal must be reported in snapshot.notes',
    )
  }
})

test('snapshot: one bad row refuses the whole row instead of trimming it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'readcache-shape-'))
  const snapPath = join(dir, 's.db')
  plantSnapshot(snapPath, [{ id: 'good', cwd: '/p' }, { cwd: '/p-no-id' }])
  const m = mountSnapshot({ snapshotPath: snapPath, snapshotMaxAgeMs: 600_000, listTtlMs: 750 })
  const served = await m.service.list()
  assert.equal(served.length, 1, 'the good-looking element must not be served on its own')
  assert.equal(served[0].id, 's1')
  assert.equal(m.calls(), 1)
})

test('snapshot: a corrupt (non-SQLite) file leaks no file descriptor', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'readcache-fd-'))
  const snapPath = join(dir, 'corrupt.db')
  writeFileSync(snapPath, 'this is plain text, definitely not a sqlite database')
  const openFds = () => readdirSync('/proc/self/fd').length
  const m = mountSnapshot({ snapshotPath: snapPath, snapshotMaxAgeMs: 600_000, listTtlMs: 0, listMaxStaleMs: 0 })
  await m.service.list()
  await new Promise((r) => setTimeout(r, 30))
  const before = openFds()
  for (let i = 0; i < 40; i++) {
    await m.service.list()
    await new Promise((r) => setTimeout(r, 2))
  }
  const after = openFds()
  assert.ok(
    after - before <= 2,
    `40 scans over a corrupt snapshot leaked ${after - before} fds (before=${before} after=${after})`,
  )
})


test('inspect: miss then hit (original called once)', async () => {
  const { ctx, service } = makeFake()
  apply(ctx, {})
  const a = await service.inspect('s1')
  const b = await service.inspect('s1')
  assert.equal(service.inspectCalls, 1, 'second call must hit cache')
  assert.equal(a, b, 'same frozen inspection object returned')
})

test('inspect: live sessions are never cached', async () => {
  const { ctx, service, live } = makeFake()
  live.add('s1')
  apply(ctx, {})
  await service.inspect('s1')
  await service.inspect('s1')
  assert.equal(service.inspectCalls, 2, 'live views must always delegate')
})

test('inspect: stale token after append re-reads', async () => {
  const { ctx, service, paths } = makeFake()
  apply(ctx, {})
  await service.inspect('s1')
  await service.inspect('s1')
  assert.equal(service.inspectCalls, 1)
  appendFileSync(paths.s1, 'yy')
  await service.inspect('s1')
  assert.equal(service.inspectCalls, 2, 'append changed size → must delegate')
})

test('inspect: LRU evicts oldest beyond maxEntries', async () => {
  const { ctx, service } = makeFake()
  apply(ctx, { maxEntries: 2 })
  await service.inspect('s1')
  await service.inspect('s2')
  await service.inspect('s3') // evicts s1
  await service.inspect('s1') // miss again
  assert.equal(service.inspectCalls, 4)
})

test('inspect: original errors propagate uncached', async () => {
  const { ctx, service } = makeFake()
  apply(ctx, {})
  await assert.rejects(() => service.inspect('nope'), /not found/)
  await assert.rejects(() => service.inspect('nope'), /not found/)
  assert.equal(service.inspectCalls, 2)
})

test('list: TTL caches repeat calls; signal bypasses cache', async () => {
  const { ctx, service } = makeFake()
  apply(ctx, { listTtlMs: 10_000 })
  const a = await service.list()
  const b = await service.list()
  assert.equal(service.listCalls, 1)
  assert.notEqual(a, b)
  assert.deepEqual(a, b)
  const ac = new AbortController()
  await service.list(ac.signal)
  assert.equal(service.listCalls, 2, 'signalled call must delegate')
})

test('list: concurrent misses coalesce into one underlying call', async () => {
  const { ctx, service } = makeFake({ listDelayMs: 20 })
  apply(ctx, { listTtlMs: 1000 })
  const [r1, r2, r3] = await Promise.all([service.list(), service.list(), service.list()])
  assert.equal(service.listCalls, 1)
  assert.deepEqual(r1, r2)
  assert.deepEqual(r2, r3)
  assert.notEqual(r1[0], r2[0], 'returned headers must be fresh objects')
})

test('list: headers are copies, mutating result cannot poison cache', async () => {
  const { ctx, service } = makeFake()
  apply(ctx, { listTtlMs: 10_000 })
  const a = await service.list()
  a[0].cwd = 'MUTATED'
  const b = await service.list()
  assert.equal(b[0].cwd, '/p1')
})

test('snapshot: a write that lands after unmount is declined, not saved', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'readcache-snap-'))
  const snapPath = join(dir, 'race.db')
  let dispose
  // Dispose while the scan is still running, so the scan resolves afterwards
  // and saveSnapshot is reached with the mount token already invalidated. That
  // ordering is what makes the guard's outcome deterministic: the write cannot
  // win the race by construction, only by the guard declining it.
  const service = {
    locate: () => ({ kind: 'fake', path: '/x' }),
    async inspect() { return { meta: {}, events: [] } },
    async list() { await new Promise((r) => setTimeout(r, 30)); return [{ id: 'slow', cwd: '/p', createdAt: 1 }] },
  }
  const routes = []
  const ctx = {
    inject: (names, cb) => cb({ sessionPersistence: service, sessions: { get: () => undefined } }),
    effect: (fn) => { dispose = fn(); return dispose },
    logger: { info: () => {}, warn: () => {} },
    webServer: { register(r) { routes.push(r); return () => {} } },
  }
  apply(ctx, { snapshotPath: snapPath, listTtlMs: 0, listMaxStaleMs: 0 })
  const pending = service.list()
  await new Promise((r) => setTimeout(r, 5)) // still inside the scan
  dispose()
  await pending
  await new Promise((r) => setTimeout(r, 120)) // the in-flight write resolves here

  let body
  routes.find((r) => r.path === '/plugin/session-readcache/metrics')
    .handler({}, { writeHead() {}, end(json) { body = JSON.parse(json) } })
  const notes = body.snapshot.notes
  assert.ok(
    notes.some((note) => note.includes('unmounted before the snapshot write landed')),
    `the racing write must be declined and reported, notes=${JSON.stringify(notes)}`,
  )
  const row = dbRow(snapPath)
  assert.equal(row, undefined, 'a declined write must leave no row behind')
})

test('snapshot: a persisted list seeds the memo at boot within its age', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'readcache-snap-'))
  const snapPath = join(dir, 'plugins', 'session-readcache', 'list-snapshot.db')

  // First mount: complete a scan; the memo writes its snapshot off the path.
  const { ctx: ctx1, service: svc1 } = makeFake()
  apply(ctx1, { snapshotPath: snapPath })
  await svc1.list()
  await new Promise((r) => setTimeout(r, 50)) // the snapshot write is asynchronous

  // Second mount with a scan that would take seconds: the seeded memo must
  // answer before the underlying list even resolves.
  const { ctx: ctx2, service: svc2 } = makeFake({ listDelayMs: 2000 })
  apply(ctx2, { listTtlMs: 750, snapshotPath: snapPath, snapshotMaxAgeMs: 600_000 })
  const t0 = performance.now()
  const served = await svc2.list()
  const servedMs = performance.now() - t0
  assert.equal(served.length, 4, 'seeded headers are served')
  assert.ok(servedMs < 1000, `boot must not wait for a real scan (took ${servedMs.toFixed(0)}ms)`)
})

test('snapshot: seedResolved is true only after the seed is attempted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'readcache-snap-'))
  const snapPath = join(dir, 'snap.db')
  const read = (ctx) => {
    let body
    ctx.webServer._registeredRoutes
      .find((r) => r.path === '/plugin/session-readcache/metrics')
      .handler({}, { writeHead() {}, end(json) { body = JSON.parse(json) } })
    return body.snapshot
  }
  const { ctx, service } = makeFake()
  apply(ctx, { snapshotPath: snapPath })
  assert.equal(read(ctx).seedResolved, false, 'before any list the seed has not been attempted')
  assert.equal(read(ctx).seeded, false)
  await service.list()
  assert.equal(read(ctx).seedResolved, true, 'after one list the seed has been attempted and resolved')
  assert.equal(read(ctx).seeded, false, 'no snapshot file existed, so nothing was seeded')
})

test('snapshot: an expired snapshot is ignored and a real scan runs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'readcache-snap-'))
  const snapPath = join(dir, 'snap.db')
  const { ctx: ctx1, service: svc1 } = makeFake()
  apply(ctx1, { snapshotPath: snapPath })
  await svc1.list()
  await new Promise((r) => setTimeout(r, 50))

  const { ctx: ctx2, service: svc2 } = makeFake({ listDelayMs: 20 })
  apply(ctx2, { listTtlMs: 750, snapshotPath: snapPath, snapshotMaxAgeMs: 1 })
  await new Promise((r) => setTimeout(r, 5)) // let the snapshot age past 1ms
  const t0 = performance.now()
  await svc2.list()
  const tookMs = performance.now() - t0
  assert.ok(tookMs >= 15, `an expired snapshot must force a real scan (returned in ${tookMs.toFixed(0)}ms)`)
  assert.equal(svc2.listCalls, 1)
})

test('list: past-TTL inside the stale window is served instantly and refreshes behind', async () => {
  const { ctx, service } = makeFake({ listDelayMs: 30 })
  apply(ctx, { listTtlMs: 1, listMaxStaleMs: 10_000 })
  await service.list()                       // scan completes, memo stamped
  await new Promise((r) => setTimeout(r, 5)) // past the 1ms TTL, far inside the stale window
  const t0 = performance.now()
  const served = await service.list()
  const servedMs = performance.now() - t0
  assert.ok(servedMs < 20, `stale path must not wait for the scan (took ${servedMs.toFixed(1)}ms)`)
  assert.equal(served.length, 4)
  await new Promise((r) => setTimeout(r, 60)) // let the background refresh land
  assert.equal(service.listCalls, 2, 'the refresh must run exactly one real scan')
  const after = await service.list()
  assert.equal(after.length, 4)
  assert.equal(service.listCalls, 2, 'a second stale read must not stack scans')
})

test('list: past the stale window the caller waits for a real scan again', async () => {
  const { ctx, service } = makeFake({ listDelayMs: 20 })
  apply(ctx, { listTtlMs: 1, listMaxStaleMs: 1 })
  await service.list()
  await new Promise((r) => setTimeout(r, 30))
  await service.list()
  assert.equal(service.listCalls, 2, 'a stale window too small to cover the gap must force a scan')
})

test('list: listMaxStaleMs 0 keeps strict-TTL behaviour', async () => {
  const { ctx, service } = makeFake({ listDelayMs: 10 })
  apply(ctx, { listTtlMs: 1, listMaxStaleMs: 0 })
  await service.list()
  await new Promise((r) => setTimeout(r, 20))
  await service.list()
  assert.equal(service.listCalls, 2, 'with no stale window every past-TTL read scans')
})

test('snapshot: path comes from the dshHomePath service when config omits it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'readcache-home-'))
  const calls = []
  const homer = (...segments) => { calls.push(segments); return join(dir, ...segments) }
  const { ctx, service } = makeFake()
  apply({ ...ctx, get: (name) => (name === 'dshHomePath' ? homer : undefined) }, {})
  await service.list()
  await new Promise((r) => setTimeout(r, 50))
  const metrics = (() => {
    let body
    ctx.webServer._registeredRoutes
      .find((r) => r.path === '/plugin/session-readcache/metrics')
      .handler({}, { writeHead() {}, end(json) { body = JSON.parse(json) } })
    return body
  })()
  assert.deepEqual(calls, [['plugins', 'session-readcache', 'list-snapshot.db']])
  assert.equal(metrics.snapshot.path, join(dir, 'plugins', 'session-readcache', 'list-snapshot.db'))
  assert.ok(existsSync(join(dir, 'plugins', 'session-readcache', 'list-snapshot.db')), 'snapshot file created under the harness home')
})

test('snapshot: a missing dshHomePath service and no env leaves persistence off', async () => {
  const saved = { ...process.env }
  delete process.env.DSH_HOME
  try {
    const { ctx, service } = makeFake()
    apply({ ...ctx, get: () => undefined }, {})
    await service.list()
    let body
    ctx.webServer._registeredRoutes
      .find((r) => r.path === '/plugin/session-readcache/metrics')
      .handler({}, { writeHead() {}, end(json) { body = JSON.parse(json) } })
    assert.equal(body.snapshot.path, null, 'no home means no snapshot, not a guessed path')
    assert.equal(await service.list().then((r) => r.length), 4, 'list still works without persistence')
  } finally {
    process.env = saved
  }
})

test('snapshot: a failed background refresh leaves the memo intact and the next read still works', async () => {
  // The underlying list must be able to start succeeding and then start
  // failing, so this fake stands in for makeFake instead of reusing it.
  const dir = mkdtempSync(join(tmpdir(), 'readcache-bgr-'))
  const id = 's1'
  const path = join(dir, id)
  writeFileSync(path, 'x')
  let calls = 0
  const service = {
    locate: () => ({ kind: 'fake', path }),
    async inspect() { return { meta: { id, cwd: '/p1' }, events: [{ seq: 0, type: 'x' }] } },
    async list() {
      calls += 1
      if (calls > 1) throw new Error('scan failed')
      return [{ id, cwd: '/p1', createdAt: 1 }]
    },
  }
  const ctx = {
    inject: (names, cb) => cb({ sessionPersistence: service, sessions: { get: () => undefined } }),
    effect: (fn) => fn(),
    logger: { info: () => {}, warn: () => {} },
    webServer: { _registeredRoutes: [], register(r) { this._registeredRoutes.push(r); return () => {} } },
  }
  apply(ctx, { listTtlMs: 1, listMaxStaleMs: 10_000 })
  const first = await service.list()
  await new Promise((r) => setTimeout(r, 5))

  const served = await service.list()
  assert.equal(served.length, 1, 'stale path still answers while the refresh fails')
  await new Promise((r) => setTimeout(r, 30)) // background refresh rejects in here

  assert.equal(calls, 2, 'the refresh did try the underlying list')
  // The failed refresh must not have installed an empty or broken memo: the
  // last good headers are still what the stale window keeps serving.
  const after = await service.list()
  assert.deepEqual(after, first, 'a failed refresh must leave the last good headers in place')
})

test('dispose restores original methods', async () => {
  const { ctx, service } = makeFake()
  let dispose
  ctx.effect = (fn) => { dispose = fn(); return dispose }
  apply(ctx, {})
  assert.notEqual(service.__readcacheApplied, undefined)
  dispose()
  assert.equal(service.__readcacheApplied, undefined)
  assert.equal(Object.prototype.hasOwnProperty.call(service, 'inspect'), false)
})

test('metrics: endpoint registered with exact path', async () => {
  const { ctx } = makeFake()
  apply(ctx, {})
  const routes = ctx.webServer._registeredRoutes
  const metricsRoute = routes.find(r => r.path === '/plugin/session-readcache/metrics')
  assert.ok(metricsRoute, 'metrics route registered')
  assert.equal(metricsRoute.kind, 'exact')
})

test('metrics: counts inspect hits/misses and list hits/misses', async () => {
  const { ctx, service } = makeFake()
  apply(ctx, {})
  // list() first: a cold inspect resolves its log path through the same memo,
  // so listing afterwards would already come back as a TTL hit.
  await service.list()        // miss
  await service.list()        // hit (TTL 750ms default)
  await service.inspect('s1') // miss
  await service.inspect('s1') // hit
  const handler = ctx.webServer._registeredRoutes[0].handler
  let body
  handler({}, { writeHead() {}, end(b) { body = b } })
  const m = JSON.parse(body)
  assert.equal(m.inspect.hits, 1)
  assert.equal(m.inspect.misses, 1)
  assert.equal(m.list.hits, 1)
  assert.equal(m.list.misses, 1)
  assert.equal(m.cache.entries, 1, 's1 cached')
})

test('purge: route registered with exact path', () => {
  const { ctx } = makeFake()
  apply(ctx, {})
  const routes = ctx.webServer._registeredRoutes
  const purgeRoute = routes.find(r => r.path === '/plugin/session-readcache/purge')
  assert.ok(purgeRoute, 'purge route registered')
  assert.equal(purgeRoute.kind, 'exact')
})

test('purge: with id removes only that entry', async () => {
  const { ctx, service } = makeFake()
  apply(ctx, {})
  await service.inspect('s1')
  await service.inspect('s2')
  assert.equal(service.inspectCalls, 2)
  // Both cached now; third call should hit
  await service.inspect('s1')
  await service.inspect('s2')
  assert.equal(service.inspectCalls, 2, 'both cached')
  // Purge s1
  const purgeRoute = ctx.webServer._registeredRoutes.find(r => r.path === '/plugin/session-readcache/purge')
  let purgeBody
  purgeRoute.handler(
    { method: 'POST', url: 'http://x/plugin/session-readcache/purge?id=s1' },
    { writeHead() {}, end(b) { purgeBody = b } },
  )
  assert.ok(purgeBody, 'purge responded')
  // s1 must be re-read (miss), s2 must still hit
  await service.inspect('s1')
  await service.inspect('s2')
  assert.equal(service.inspectCalls, 3, 's1 re-read after purge, s2 still cached')
})

test('purge: without id clears all entries', async () => {
  const { ctx, service } = makeFake()
  apply(ctx, {})
  await service.inspect('s1')
  await service.inspect('s2')
  assert.equal(service.inspectCalls, 2)
  const purgeRoute = ctx.webServer._registeredRoutes.find(r => r.path === '/plugin/session-readcache/purge')
  purgeRoute.handler(
    { method: 'POST', url: 'http://x/plugin/session-readcache/purge' },
    { writeHead() {}, end() {} },
  )
  // Both must be re-read
  await service.inspect('s1')
  await service.inspect('s2')
  assert.equal(service.inspectCalls, 4, 'both re-read after full purge')
})

test('purge: non-POST is rejected', async () => {
  const { ctx, service } = makeFake()
  apply(ctx, {})
  await service.inspect('s1')
  const purgeRoute = ctx.webServer._registeredRoutes.find(r => r.path === '/plugin/session-readcache/purge')
  let status
  purgeRoute.handler(
    { method: 'GET', url: 'http://x/plugin/session-readcache/purge' },
    { writeHead(code) { status = code }, end() {} },
  )
  assert.equal(status, 405, 'GET must be refused')
  assert.equal(service.inspectCalls, 1, 'GET must not mutate the cache')
})

test('purge: metrics reflects entry count after purge', async () => {
  const { ctx, service } = makeFake()
  apply(ctx, {})
  await service.inspect('s1')
  await service.inspect('s2')
  const purgeRoute = ctx.webServer._registeredRoutes.find(r => r.path === '/plugin/session-readcache/purge')
  purgeRoute.handler(
    { method: 'POST', url: 'http://x/plugin/session-readcache/purge?id=s1' },
    { writeHead() {}, end() {} },
  )
  const metricsRoute = ctx.webServer._registeredRoutes.find(r => r.path === '/plugin/session-readcache/metrics')
  let body
  metricsRoute.handler({}, { writeHead() {}, end(b) { body = b } })
  const m = JSON.parse(body)
  assert.equal(m.cache.entries, 1, 'only s2 remains after purging s1')
})

test('purge: reads in flight when the purge lands do not repopulate the cache', async () => {
  const { ctx, service } = makeFake({ listDelayMs: 30 })
  apply(ctx, {})
  const pending = Promise.all([service.inspect('s1'), service.inspect('s2')])
  // Both reads are inside the underlying call when the purge lands.
  await new Promise((resolve) => setTimeout(resolve, 10))
  const purgeRoute = ctx.webServer._registeredRoutes.find(r => r.path === '/plugin/session-readcache/purge')
  purgeRoute.handler(
    { method: 'POST', url: 'http://x/plugin/session-readcache/purge' },
    { writeHead() {}, end() {} },
  )
  await pending
  const metricsRoute = ctx.webServer._registeredRoutes.find(r => r.path === '/plugin/session-readcache/metrics')
  let body
  metricsRoute.handler({}, { writeHead() {}, end(b) { body = b } })
  assert.equal(JSON.parse(body).cache.entries, 0, 'a read that started before the purge must not cache its view')
})

test('purge: a read parked on the cache-hit path cannot restore the purged entry', async () => {
  const { ctx, service } = makeFake()
  apply(ctx, {})
  await service.inspect('s1')
  assert.equal(service.inspectCalls, 1)
  // inspectRead suspends on the revision stat while the entry is resident, so
  // a synchronous purge lands inside that await.
  const parked = service.inspect('s1')
  const purgeRoute = ctx.webServer._registeredRoutes.find(r => r.path === '/plugin/session-readcache/purge')
  purgeRoute.handler(
    { method: 'POST', url: 'http://x/plugin/session-readcache/purge?id=s1' },
    { writeHead() {}, end() {} },
  )
  await parked
  assert.equal(service.inspectCalls, 1, 'the parked read still answers from cache')
  const metricsRoute = ctx.webServer._registeredRoutes.find(r => r.path === '/plugin/session-readcache/metrics')
  let body
  metricsRoute.handler({}, { writeHead() {}, end(b) { body = b } })
  const m = JSON.parse(body)
  assert.equal(m.cache.entries, 0, 'the parked hit must not put the purged entry back')
  assert.equal(m.cache.totalCost, 0, 'totalCost must not keep a cost nobody owns')
  // README: after a purge, the next inspect re-reads from disk.
  await service.inspect('s1')
  assert.equal(service.inspectCalls, 2, 'next read must miss and go to disk')
})

test('inspect: a write inside the read window never gets certified by a later stat', async () => {
  const { ctx, service, paths } = makeFake({ listDelayMs: 20 })
  apply(ctx, {})
  await service.inspect('s1')          // first read learns where s1's log lives
  await service.inspect('s1')
  assert.equal(service.inspectCalls, 1)
  // The next read parses the file, then an external writer appends while that
  // parse is still in flight.
  const pending = service.inspect('s2')
  await new Promise((resolve) => setTimeout(resolve, 10))
  appendFileSync(paths.s2, 'yy')
  await pending
  // A second read must not be answered from a view that predates the append.
  await service.inspect('s2')
  assert.equal(service.inspectCalls, 3, 'the mid-read write must not be certified by the post-read stat')
})

test('inspect: a known log path survives a cold memo instead of rescanning', async () => {
  const { ctx, service, paths } = makeFake()
  // listTtlMs 0 disables the shared memo, so only the remembered path can stop
  // a rescan; without it every re-read below would pay for another scan.
  apply(ctx, { listTtlMs: 0 })
  await service.inspect('s1')
  assert.equal(service.listCalls, 1, 'first read resolves the path once')
  // Force a miss each round: the entry is dropped, so pathForId runs again.
  for (let i = 0; i < 4; i++) {
    appendFileSync(paths.s1, 'z')
    await service.inspect('s1')
  }
  assert.equal(service.inspectCalls, 5, 'each round really was a miss')
  assert.equal(service.listCalls, 1, 'a known path must not rescan even with the memo cold')
})

test('inspect: a listed header that names a different artifact installs nothing', async () => {
  const { ctx, service, paths } = makeFake({ listDelayMs: 20 })
  // The listed header points at one artifact while the meta that inspect()
  // returns points at another, so the pre-read stat proved nothing about the
  // content that came back.
  service.list = async () => [{ id: 's1', cwd: '/listed', createdAt: 1 }]
  service.locate = (meta) => ({ kind: 'fake', path: meta.cwd === '/listed' ? paths.s1 : `${paths.s1}.relocated` })
  apply(ctx, {})
  await service.inspect('s1')
  await service.inspect('s1')
  assert.equal(service.inspectCalls, 2, 'certifying an artifact the content did not come from is refused')
})

test('inspect: no pre-read stat means no cache entry at all', async () => {
  const { ctx, service } = makeFake({ listDelayMs: 20 })
  service.list = async () => { throw new Error('list unavailable') }
  apply(ctx, {})
  await service.inspect('s1')
  await service.inspect('s1')
  assert.equal(service.inspectCalls, 2, 'a post-read stat must not stand in for the pre-read one')
})

test('inspect: stale counts a moved file, not a session that became live', async () => {
  const { ctx, service, live, paths } = makeFake()
  apply(ctx, {})
  await service.inspect('s1')
  const readMetrics = () => {
    const route = ctx.webServer._registeredRoutes.find(r => r.path === '/plugin/session-readcache/metrics')
    let body
    route.handler({}, { writeHead() {}, end(x) { body = x } })
    return JSON.parse(body).inspect
  }
  const cold = readMetrics()
  assert.equal(cold.stale, 0, 'a first read is not stale')

  live.add('s1')                                    // attach; nothing rewrites the artifact
  const before = statSync(paths.s1).size
  await service.inspect('s1')
  const attached = readMetrics()
  assert.equal(statSync(paths.s1).size, before, 'the artifact really was not touched')
  assert.equal(attached.stale, 0, 'liveness must not be reported as a stat mismatch')
  assert.equal(attached.liveSkips, 1, 'the transition is booked under liveSkips')
})

test('inspect: a real append still counts as stale', async () => {
  const { ctx, service, paths } = makeFake()
  apply(ctx, {})
  await service.inspect('s1')
  appendFileSync(paths.s1, 'yy')                    // size changes, so no mtime-resolution race
  await service.inspect('s1')
  const route = ctx.webServer._registeredRoutes.find(r => r.path === '/plugin/session-readcache/metrics')
  let body
  route.handler({}, { writeHead() {}, end(x) { body = x } })
  assert.equal(JSON.parse(body).inspect.stale, 1, 'a moved file is still a stat mismatch')
})

test('list: a signalled scan is booked like any other', async () => {
  const { ctx, service } = makeFake()
  apply(ctx, {})
  const readList = () => {
    const route = ctx.webServer._registeredRoutes.find(r => r.path === '/plugin/session-readcache/metrics')
    let body
    route.handler({}, { writeHead() {}, end(x) { body = x } })
    return JSON.parse(body).list
  }
  await service.list()
  assert.equal(readList().misses, 1, 'the unsigned scan is a miss')

  // A signalled caller bypasses the memo and rescans the whole store; the
  // counter has to move or misses is not the honest scan count README claims.
  await service.list(new AbortController().signal)
  assert.equal(readList().misses, 2, 'a signalled scan is counted too')
  assert.equal(service.listCalls, 2, 'and it really did rescan')

  await service.list(new AbortController().signal)
  assert.equal(readList().misses, 3, 'every scan stays accounted for')
  assert.equal(service.listCalls, 3, 'misses never trails the real scans')
})

test('list: a caller cancelled before the scan costs no miss', async () => {
  const { ctx, service } = makeFake()
  apply(ctx, {})
  const readList = () => {
    const route = ctx.webServer._registeredRoutes.find(r => r.path === '/plugin/session-readcache/metrics')
    let body
    route.handler({}, { writeHead() {}, end(x) { body = x } })
    return JSON.parse(body).list
  }
  const ac = new AbortController()
  ac.abort()
  // The host rejects a pre-aborted read before touching disk, so nothing walks
  // a directory here and misses must not claim that something did.
  await assert.rejects(() => service.list(ac.signal), /aborted/)
  assert.equal(readList().misses, 0, 'no directory scan happened, so no miss is booked')

  // A live signalled caller still scans, and that one is booked.
  await service.list(new AbortController().signal)
  assert.equal(readList().misses, 1, 'a real signalled scan is still counted')
  assert.equal(service.listCalls, 2, 'both calls reached the backend')
})

test('inspect: a live session never triggers a directory scan', async () => {
  const { ctx, service, live } = makeFake()
  apply(ctx, {})
  live.add('s1')                                    // attached before the first read
  await service.inspect('s1')
  // The host answers a live session from memory and touches no disk; resolving
  // a log path for it first would buy a scan whose result is never installed.
  assert.equal(service.listCalls, 0, 'no directory scan for a session the host serves from memory')
  assert.equal(service.inspectCalls, 1, 'still delegates exactly once')
  const route = ctx.webServer._registeredRoutes.find(r => r.path === '/plugin/session-readcache/metrics')
  let body
  route.handler({}, { writeHead() {}, end(x) { body = x } })
  const m = JSON.parse(body)
  assert.equal(m.inspect.liveSkips, 1, 'the refusal is still booked')
  assert.equal(m.cache.entries, 0, 'and nothing was cached')
})

test('inspect: a live session still caches once it detaches', async () => {
  const { ctx, service, live } = makeFake()
  apply(ctx, {})
  live.add('s1')
  await service.inspect('s1')                       // detached-skip path: no scan
  live.delete('s1')
  await service.inspect('s1')                       // detached: normal miss, path resolved
  assert.equal(service.inspectCalls, 2)
  const route = ctx.webServer._registeredRoutes.find(r => r.path === '/plugin/session-readcache/metrics')
  let body
  route.handler({}, { writeHead() {}, end(x) { body = x } })
  assert.equal(JSON.parse(body).cache.entries, 1, 'caching resumes after detaching')
  assert.ok(service.listCalls >= 1, 'the detached read does resolve a path')
})

let failed = 0
for (const [label, fn] of tests) {
  try { await fn(); console.log(`PASS ${label}`) }
  catch (error) { failed += 1; console.error(`FAIL ${label}\n  ${error.stack ?? error.message}`) }
}
console.log(failed === 0 ? `ALL ${tests.length} PASS` : `${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)

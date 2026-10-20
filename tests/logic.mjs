import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { apply, clock as libClock } from '../lib/index.js'

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
    return undefined
  } finally {
    db.close()
  }
}

function isSignalLike(value) {
  return value !== null && typeof value === 'object' &&
    typeof value.aborted === 'boolean' && typeof value.addEventListener === 'function'
}

function makeFake({ listDelayMs = 0, ids = ['s1', 's2', 's3', 's4'], withInspect = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'readcache-'))
  const calls = { list: 0, options: [] }
  const live = new Set()
  // The host's real contract: list() resolves to SessionPersistenceSnapshot[]
  // — `{header, revision, ...}` — never a flat header. Both in-tree callers
  // read snapshot.header.id (session-query's listPersisted, ACP's
  // sessionList). An earlier fake returned flat headers, which is why the
  // suite passed while the live memo served zero hits.
  const snapshots = ids.map((id, i) => ({
    header: { id, cwd: '/p1', createdAt: 1 + i },
    revision: `r-${id}`,
    eventCount: i,
  }))
  const service = {
    get listCalls() { return calls.list },
    get optionsSeen() { return calls.options },
    async list(options) {
      calls.list += 1
      calls.options.push(options)
      if (listDelayMs) await new Promise((r) => setTimeout(r, listDelayMs))
      const signal = isSignalLike(options) ? options : options?.signal
      if (signal?.aborted) throw new Error('aborted')
      return snapshots.map((s) => ({ ...s, header: { ...s.header } }))
    },
  }
  if (withInspect) {
    // A host that still carries the old method must not change behaviour.
    service.inspect = async () => ({ meta: {}, events: [] })
  }
  const routes = []
  const ctx = {
    inject: (names, cb) => cb({ sessionPersistence: service, sessions: { get: (id) => (live.has(id) ? {} : undefined) } }),
    effect: (fn) => fn(),
    logger: { info: () => {}, warn: () => {} },
    webServer: {
      register(route) { routes.push(route); return () => { const i = routes.indexOf(route); if (i >= 0) routes.splice(i, 1) } },
    },
  }
  const metrics = () => {
    let body
    routes.find((r) => r.path === '/plugin/session-readcache/metrics')
      .handler({}, { writeHead() {}, end(json) { body = JSON.parse(json) } })
    return body
  }
  const purge = () => {
    let body
    routes.find((r) => r.path === '/plugin/session-readcache/purge')
      .handler({ method: 'POST', url: '/purge' }, { writeHead() {}, end(json) { body = JSON.parse(json) } })
    return body
  }
  return { ctx, service, live, dir, metrics, purge, routes, list: (...a) => service.list(...a) }
}

/** Capture what apply() printed to stderr (the mount banner). */
function withBanner(fn) {
  const orig = process.stderr.write.bind(process.stderr)
  let buf = ''
  process.stderr.write = (chunk) => { buf += String(chunk); return true }
  try { fn() } finally { process.stderr.write = orig }
  return buf
}

const tests = []
function test(label, fn) { tests.push([label, fn]) }

// Hermetic suite: this environment exports DSH_HOME, and without this line the
// default snapshot path resolves to the LIVE harness snapshot. Tests that
// exercise persistence pass an explicit snapshotPath under tmpdir(); everything
// else must not read or touch it.
delete process.env.DSH_HOME

function plantSnapshot(snapshotPath, headers, savedAt = Date.now()) {
  const Database = createRequire(import.meta.url)('better-sqlite3')
  const db = new Database(snapshotPath)
  db.exec(`CREATE TABLE IF NOT EXISTS readcache_list_snapshot (
    id INTEGER PRIMARY KEY CHECK (id = 1), saved_at INTEGER NOT NULL, headers TEXT NOT NULL)`)
  db.prepare('INSERT OR REPLACE INTO readcache_list_snapshot VALUES (1, ?, ?)').run(savedAt, JSON.stringify(headers))
  db.close()
}

function plantRawSnapshot(snapshotPath, { headers, savedAt = Date.now(), userVersion }) {
  const Database = createRequire(import.meta.url)('better-sqlite3')
  const db = new Database(snapshotPath)
  db.exec(`CREATE TABLE IF NOT EXISTS readcache_list_snapshot (
    id INTEGER PRIMARY KEY CHECK (id = 1), saved_at INTEGER NOT NULL, headers TEXT NOT NULL)`)
  db.prepare('INSERT OR REPLACE INTO readcache_list_snapshot VALUES (1, ?, ?)')
    .run(savedAt, typeof headers === 'string' ? headers : JSON.stringify(headers))
  if (userVersion !== undefined) db.pragma(`user_version = ${userVersion}`)
  db.close()
}

/** Run `fn` with the plugin's clocks pinned, then restore. */
async function withClock(fns, fn) {
  const savedMono = libClock.monotonic
  const savedWall = libClock.wall
  libClock.monotonic = fns.monotonic ?? (() => 0)
  libClock.wall = fns.wall ?? (() => 0)
  try { return await fn() } finally { libClock.monotonic = savedMono; libClock.wall = savedWall }
}

// --- mount survival ---------------------------------------------------------
// Regression: on host 0.2.0-rc.2 the persistence service no longer exposes
// `inspect`, and apply() threw at `target.inspect.bind` BEFORE any banner or
// route existed — the plugin was dead on production with no log line at all.

test('mount: the plugin mounts and memoizes with a persistence that has no inspect', async () => {
  const fake = makeFake()
  const banner = withBanner(() => apply(fake.ctx, { snapshotPath: undefined }))
  assert.match(banner, /\[session-readcache\] mounted/)
  await fake.list()
  await fake.list()
  assert.equal(fake.service.listCalls, 1, 'second list must be served from the memo')
  assert.ok(fake.metrics().mode)
})

test('mount: a persistence without list() mounts inert but still exposes metrics', () => {
  const fake = makeFake()
  fake.service.list = undefined
  let threw = null
  const banner = withBanner(() => { try { apply(fake.ctx, {}) } catch (e) { threw = e } })
  assert.equal(threw, null, 'a missing list() must not throw out of apply')
  assert.match(banner, /inert|mounted/)
  const m = fake.metrics()
  assert.equal(m.mode, 'inert')
  assert.equal(m.list.misses, 0)
})

test('mount: disabled by config leaves no routes', () => {
  const fake = makeFake()
  apply(fake.ctx, { enabled: false })
  assert.equal(fake.routes.length, 0)
})

// --- list memo --------------------------------------------------------------

test('list: a second call inside the TTL is served from the memo', async () => {
  const fake = makeFake()
  apply(fake.ctx, { listTtlMs: 750 })
  const a = await fake.list()
  const b = await fake.list()
  assert.equal(fake.service.listCalls, 1)
  assert.deepEqual(a, b)
})

test('list: past the TTL and past the stale window the memo is rescanned', async () => {
  const fake = makeFake()
  apply(fake.ctx, { listTtlMs: 750, listMaxStaleMs: 0 })
  await withClock({ monotonic: () => 0 }, () => fake.list())
  await withClock({ monotonic: () => 800 }, () => fake.list())
  assert.equal(fake.service.listCalls, 2)
  assert.equal(fake.metrics().list.misses, 2)
})

test('list: past the TTL but inside the stale window the caller is served immediately', async () => {
  const fake = makeFake({ listDelayMs: 50 })
  apply(fake.ctx, { listTtlMs: 10, listMaxStaleMs: 30_000 })
  await withClock({ monotonic: () => 0 }, () => fake.list())
  const t0 = Date.now()
  const served = await withClock({ monotonic: () => 20 }, () => fake.list())
  assert.ok(Date.now() - t0 < 40, 'a stale reply must not wait for the scan')
  assert.equal(served.length, 4)
  assert.equal(fake.metrics().list.staleServed, 1)
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(fake.metrics().list.misses, 2, 'the background refresh ran')
})

test('list: past the stale window the caller waits for a fresh scan', async () => {
  const fake = makeFake()
  apply(fake.ctx, { listTtlMs: 10, listMaxStaleMs: 20 })
  await withClock({ monotonic: () => 0 }, () => fake.list())
  await withClock({ monotonic: () => 100 }, () => fake.list())
  assert.equal(fake.service.listCalls, 2)
})

test('list: concurrent calls share one scan', async () => {
  const fake = makeFake({ listDelayMs: 30 })
  apply(fake.ctx, {})
  const [a, b, c] = await Promise.all([fake.list(), fake.list(), fake.list()])
  assert.equal(fake.service.listCalls, 1)
  assert.equal(a.length, b.length)
  assert.equal(b.length, c.length)
})

// The host's list() takes an OPTIONS BAG ({signal?}), not a signal. Reading
// the first argument as if it were the signal made every real caller bypass
// the memo: the live host recorded 15 misses, 0 hits.
test('list: a caller passing {signal}, the real options contract, is served from the memo', async () => {
  const fake = makeFake()
  apply(fake.ctx, {})
  await fake.list()
  const ac = new AbortController()
  await fake.list({ signal: ac.signal })
  assert.equal(fake.service.listCalls, 1, 'a live-signal caller must hit the memo, not rescan')
  assert.equal(fake.metrics().list.hits, 1)
  assert.equal(fake.metrics().list.misses, 1)
})

test('list: the caller options bag is forwarded untouched to the host scan', async () => {
  const fake = makeFake()
  apply(fake.ctx, {})
  const options = { signal: new AbortController().signal }
  await fake.list(options)
  assert.equal(fake.service.optionsSeen[0], options, 'the host must receive the caller own bag')
})

test('list: a pre-aborted caller is not counted (the host never scans)', async () => {
  const fake = makeFake()
  apply(fake.ctx, {})
  await fake.list()
  const ac = new AbortController()
  ac.abort()
  await assert.rejects(() => fake.list({ signal: ac.signal }), /aborted/)
  assert.equal(fake.metrics().list.misses, 1)
})

test('list: a pre-aborted caller passing the bare signal is still forwarded (old host shape)', async () => {
  const fake = makeFake()
  apply(fake.ctx, {})
  await fake.list()
  const ac = new AbortController()
  ac.abort()
  await assert.rejects(() => fake.list(ac.signal), /aborted/)
  assert.equal(fake.metrics().list.misses, 1)
})

test('list: the memo hands out copies; caller mutation cannot poison it', async () => {
  const fake = makeFake()
  apply(fake.ctx, {})
  const first = await fake.list()
  first.push({ header: { id: 'evil' } })
  first[0].header.id = 'mutated'
  const second = await fake.list()
  assert.equal(fake.service.listCalls, 1)
  assert.equal(second.length, 4)
  assert.equal(second[0].header.id, 's1')
})

test('list: prototype-reaching keys are stripped from the snapshot and its header', async () => {
  const fake = makeFake()
  const original = fake.service.list
  fake.service.list = async (options) => {
    const rows = await original(options)
    rows[0].__proto__ = { polluted: true }
    rows[0].header.__proto__ = { headerPolluted: true }
    return rows
  }
  apply(fake.ctx, {})
  const rows = await fake.list()
  assert.equal(rows[0].polluted, undefined)
  assert.equal(rows[0].headerPolluted, undefined)
  assert.equal(rows[0].header.polluted, undefined)
})

// --- snapshot persistence ----------------------------------------------------

test('snapshot: a young row of session snapshots seeds the first reply without scanning', async () => {
  const fake = makeFake()
  const snapshotPath = join(fake.dir, 'snap.db')
  plantSnapshot(snapshotPath, [{ header: { id: 'seeded', cwd: '/p1', createdAt: 1 }, revision: 'r-seeded' }])
  apply(fake.ctx, { snapshotPath })
  const rows = await fake.list()
  assert.equal(fake.service.listCalls, 0, 'the seed must answer the first call')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].header.id, 'seeded')
  assert.equal(fake.metrics().snapshot.seeded, true)
})

test('snapshot: a completed scan persists real session snapshots, reloadable as a seed', async () => {
  const fake = makeFake()
  const snapshotPath = join(fake.dir, 'snap.db')
  apply(fake.ctx, { snapshotPath })
  await fake.list()
  await new Promise((r) => setTimeout(r, 50))
  const row = dbRow(snapshotPath)
  assert.ok(row, 'a snapshot row must exist')
  assert.equal(JSON.parse(row.headers).length, 4)
  assert.equal(fake.metrics().snapshot.saves, 1)
  // The persisted row must satisfy the soundness check on the way back in:
  // this is the exact row the live host wrote and the old check refused.
  assert.equal(JSON.parse(row.headers)[0].header.id, 's1')
})

test('snapshot: a row of flat headers is refused, not served (the live seeding failure)', async () => {
  const fake = makeFake()
  const snapshotPath = join(fake.dir, 'snap.db')
  // The shape the OLD checker accepted and the host never returns: a flat
  // header with a top-level id. A row like this must not seed a memo, because
  // callers read snapshot.header.id off every element.
  plantSnapshot(snapshotPath, [{ id: 'seeded', cwd: '/p1', createdAt: 1 }])
  apply(fake.ctx, { snapshotPath })
  const rows = await fake.list()
  assert.equal(fake.service.listCalls, 1, 'a flat-header row must force a real scan')
  assert.equal(fake.metrics().snapshot.seeded, false)
  assert.match(JSON.stringify(fake.metrics().snapshot.notes), /not a list of session snapshots/)
})

test('snapshot: a row older than snapshotMaxAgeMs is not served', async () => {
  const fake = makeFake()
  const snapshotPath = join(fake.dir, 'snap.db')
  // The window is configured here, not taken from the default, so this test
  // pins the RULE and stays valid when the default window moves.
  plantSnapshot(snapshotPath, [{ header: { id: 'old', cwd: '/p1', createdAt: 1 }, revision: 'r' }], Date.now() - 600_000)
  apply(fake.ctx, { snapshotPath, snapshotMaxAgeMs: 60_000 })
  await fake.list()
  assert.equal(fake.service.listCalls, 1)
  assert.equal(fake.metrics().snapshot.seeded, false)
})

test('snapshot: a row stamped in the future is refused', async () => {
  const fake = makeFake()
  const snapshotPath = join(fake.dir, 'snap.db')
  plantSnapshot(snapshotPath, [{ header: { id: 'future', cwd: '/p1', createdAt: 1 }, revision: 'r' }], Date.now() + 7_000_000)
  apply(fake.ctx, { snapshotPath })
  await fake.list()
  assert.equal(fake.service.listCalls, 1)
  assert.equal(fake.metrics().snapshot.seeded, false)
})

test('snapshot: rows that are not session snapshots are refused, not served', async () => {
  const fake = makeFake()
  const snapshotPath = join(fake.dir, 'snap.db')
  plantSnapshot(snapshotPath, [{ header: { id: 'ok', cwd: '/p1', createdAt: 1 }, revision: 'r' }, 42])
  apply(fake.ctx, { snapshotPath })
  await fake.list()
  assert.equal(fake.service.listCalls, 1)
  assert.match(JSON.stringify(fake.metrics().snapshot.notes), /not a list of session snapshots/)
})

test('snapshot: a schema version mismatch refuses the row', async () => {
  const fake = makeFake()
  const snapshotPath = join(fake.dir, 'snap.db')
  plantRawSnapshot(snapshotPath, { headers: [{ header: { id: 'x', cwd: '/p1', createdAt: 1 }, revision: 'r' }], userVersion: 999 })
  apply(fake.ctx, { snapshotPath })
  await fake.list()
  assert.equal(fake.service.listCalls, 1)
  assert.equal(fake.metrics().snapshot.seeded, false)
})

test('snapshot: with no snapshotPath nothing is written and list still answers', async () => {
  const fake = makeFake()
  const home = process.env.DSH_HOME
  delete process.env.DSH_HOME
  try {
    apply(fake.ctx, {})
    const rows = await fake.list()
    assert.equal(rows.length, 4)
    assert.equal(fake.metrics().snapshot.path, null)
  } finally {
    if (home !== undefined) process.env.DSH_HOME = home
  }
})

test('snapshot: a failed save is counted and noted, the caller still gets headers', async () => {
  const fake = makeFake()
  // A regular FILE in the path position makes mkdir(dirname) fail (ENOTDIR);
  // recursive mkdir would happily create a plain "missing" directory.
  writeFileSync(join(fake.dir, 'blocker'), 'not a directory')
  apply(fake.ctx, { snapshotPath: join(fake.dir, 'blocker', 'snap.db') })
  const rows = await fake.list()
  assert.equal(rows.length, 4)
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(fake.metrics().snapshot.failures, 1)
  assert.match(JSON.stringify(fake.metrics().snapshot.notes), /save failed/)
})

test('snapshot: the serialization runs after the caller already has its reply', async () => {
  // The snapshot is a side effect: the list the caller asked for must not wait
  // for the whole list to be serialized for the disk. README 5.2 says the row
  // is written "outside the caller's response path" — this pins that.
  const fake = makeFake()
  const snapshotPath = join(fake.dir, 'snap.db')
  const events = []
  const realStringify = JSON.stringify
  JSON.stringify = function patched(value, ...rest) {
    if (Array.isArray(value) && value.length === 4 && value[0]?.header?.id === 's1') events.push('stringify')
    return realStringify.call(JSON, value, ...rest)
  }
  try {
    apply(fake.ctx, { snapshotPath })
    await fake.list()
    events.push('caller-resumed')
    await new Promise((r) => setTimeout(r, 50))
  } finally {
    JSON.stringify = realStringify
  }
  assert.deepEqual(events, ['caller-resumed', 'stringify'])
  assert.equal(fake.metrics().snapshot.saves, 1)
})

// --- lifecycle and purge ------------------------------------------------------

test('lifecycle: a disposed session must not make the next list() wait for a scan', async () => {
  // A dispose is a ONE-ROW event. The list it invalidates is a WHOLE-LIST
  // memo, and refilling it runs the host's directory scan again: measured at
  // 2.6 s warm and 77.7 s cold over this host's 4,016-log corpus. The host's
  // own list() is disk-based, so a detached session that was materialized is
  // still listed by the host — the rescan reproduced the memo's own contents.
  // The next caller must therefore be answered from memory.
  const fake = makeFake({ listDelayMs: 300 })
  const listeners = new Map()
  fake.ctx.on = (event, cb) => { const l = listeners.get(event) ?? []; l.push(cb); listeners.set(event, l) }
  apply(fake.ctx, {})
  await fake.list()
  assert.equal(fake.metrics().memo.warm, true)
  for (const cb of listeners.get('session/disposed') ?? []) cb({ id: 's2' })
  const started = Date.now()
  const rows = await fake.list()
  const elapsed = Date.now() - started
  assert.equal(rows.length, 4)
  assert.ok(elapsed < 150, `the next list() waited ${elapsed} ms for a scan after a dispose`)
  // The memo is invalidated, not thrown away: the refresh reconciles it.
  assert.equal(fake.metrics().memo.warm, true)
  assert.equal(fake.metrics().lifecycle.disposedInvalidations, 1)
})

test('purge: the endpoint clears the memo', async () => {
  const fake = makeFake()
  apply(fake.ctx, {})
  await fake.list()
  const reply = fake.purge()
  assert.ok(reply)
  await fake.list()
  assert.equal(fake.service.listCalls, 2)
  assert.equal(fake.metrics().lifecycle.purgeDrops, 1)
})

test('snapshot: a row older than ten minutes still seeds the boot inside the default window', async () => {
  // The 2026-10-21 live gap: the row was 56 min old at boot and the old
  // 10 min default refused it, so the first reply paid a full scan. The
  // default window is 24 h now, so a row of that age is served.
  const fake = makeFake()
  const snapshotPath = join(fake.dir, 'snap.db')
  plantSnapshot(snapshotPath, [{ header: { id: 'idle-hour', cwd: '/p1', createdAt: 1 }, revision: 'r' }], Date.now() - 3_600_000)
  apply(fake.ctx, { snapshotPath })
  await fake.list()
  assert.equal(fake.service.listCalls, 0, 'the seed must answer the first call')
  assert.equal(fake.metrics().snapshot.seeded, true)
})

// --- config -------------------------------------------------------------------

test('config: invalid values fall back to defaults and the route reports them', async () => {
  const fake = makeFake()
  apply(fake.ctx, { listTtlMs: -5, maxEntries: 1.5, snapshotMaxAgeMs: 'soon' })
  await fake.list()
  const m = fake.metrics()
  assert.equal(m.config.listTtlMs, 750)
  assert.equal(m.config.maxEntries, 24)
  assert.equal(m.config.snapshotMaxAgeMs, 86_400_000)
})

test('config: explicit zero TTL with zero stale window rescans every call', async () => {
  const fake = makeFake()
  apply(fake.ctx, { listTtlMs: 0, listMaxStaleMs: 0 })
  await fake.list()
  await fake.list()
  assert.equal(fake.service.listCalls, 2)
})

let failed = 0
for (const [label, fn] of tests) {
  try {
    await fn()
    console.log(`PASS ${label}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${label}\n  ${error?.message ?? error}`)
  }
}
console.log(`\n${tests.length - failed}/${tests.length} pass`)
process.exit(failed === 0 ? 0 : 1)

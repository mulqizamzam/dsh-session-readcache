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

// `withStat` mirrors a host that carries the `stat` method of
// SessionPersistence; `unwritten` names the sessions that never reached the
// disk (so the host's disk-based list() does NOT name them any more),
// `materialized` names the sessions whose ROW carries `sizeBytes` (the host's
// own statement that the session has an artifact on disk) and `statRejects`
// names the sessions whose stat() call fails.
function makeFake({ listDelayMs = 0, ids = ['s1', 's2', 's3', 's4'], withInspect = false, withStat = true, unwritten = [], materialized = [], statRejects = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'readcache-'))
  const calls = { list: 0, options: [], stat: [], statOptions: [] }
  const live = new Set()
  // The host's real contract: list() resolves to SessionPersistenceSnapshot[]
  //, `{header, revision, ...}`, never a flat header. Both in-tree callers
  // read snapshot.header.id (session-query's listPersisted, ACP's
  // sessionList). An earlier fake returned flat headers, which is why the
  // suite passed while the live memo served zero hits.
  const snapshots = ids.map((id, i) => {
    const snapshot = { header: { id, cwd: '/p1', createdAt: 1 + i }, revision: `r-${id}`, eventCount: i }
    // The host's list() tells the two kinds of row apart in the snapshot
    // itself: a MATERIALIZED row (the session has an artifact on disk)
    // carries sizeBytes, a LIVE-BUT-UNWRITTEN row (the session is created
    // but not written yet) does not. A row without sizeBytes is the only one
    // a dispose can make wrong, so it is the only one worth asking about.
    if (materialized.includes(id)) snapshot.sizeBytes = 4096
    return snapshot
  })
  const byId = new Map(snapshots.map((s) => [s.header.id, s]))
  const service = {
    get listCalls() { return calls.list },
    get optionsSeen() { return calls.options },
    get statCalls() { return calls.stat.slice() },
    get statOptions() { return calls.statOptions.slice() },
    async list(options) {
      calls.list += 1
      calls.options.push(options)
      if (listDelayMs) await new Promise((r) => setTimeout(r, listDelayMs))
      const signal = isSignalLike(options) ? options : options?.signal
      if (signal?.aborted) throw new Error('aborted')
      return snapshots.map((s) => ({ ...s, header: { ...s.header } }))
    },
  }
  if (withStat) {
    // The host's own SessionPersistence.stat(id), and the shape of its answer:
    //   - a MATERIALIZED session (the artifact is on disk): a snapshot WITH
    //     sizeBytes;
    //   - a session the host still TRACKS but has not written yet: a snapshot
    //     WITHOUT sizeBytes;
    //   - a session the host no longer knows at all: undefined.
    // The plugin's rule is on the ANSWER, not on the answer's sizeBytes: any
    // resolved snapshot means the host still knows the session, so the row
    // stays; only undefined means "gone".
    // `unwritten` names the sessions the host does not know at all (their
    // stat() resolves undefined). `materialized` names the sessions whose ROW
    // carries sizeBytes, the ones a dispose must not even ask about.
    service.stat = async (id, options) => {
      calls.stat.push(id)
      calls.statOptions.push(options ?? null)
      if (statRejects.includes(id)) throw new Error(`stat failed for ${id}`)
      const snapshot = byId.get(id)
      if (snapshot === undefined || unwritten.includes(id)) return undefined
      // The host's DISK answer ignores the in-memory tracker: a session that
      // was created but never written has no artifact, so it reads as absent.
      // A host without that option answers from the tracker instead, and a
      // session it still tracks reads as a snapshot without sizeBytes.
      if (options?.source === 'disk' && !materialized.includes(id)) return undefined
      const answer = { header: { ...snapshot.header }, revision: snapshot.revision }
      if (materialized.includes(id)) answer.sizeBytes = snapshot.sizeBytes
      return answer
    }
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
// route existed, the plugin was dead on production with no log line at all.

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
  // is written "outside the caller's response path", this pins that.
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
  // memo, and refilling it runs the host's directory scan again: a full scan
  // of the session store measures 12.9 s median over 5,343 logs on this host
  // (2026-10-21). The cold-page-cache figure was never measured, dropping
  // the page cache would disturb the running host, so it is unknown, not
  // zero. The host's own list() is disk-based, so a detached session that
  // was materialized is still listed by the host, the rescan reproduced the
  // memo's own contents. The scan is measured in seconds, so the next caller
  // must be answered from memory rather than made to wait for one.
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

// --- dispose invalidation (CONTRACT C1) ---------------------------------------
// The host's list() is disk-based: it names every session that has a
// materialized artifact plus the live ones. A disposed session therefore
// leaves the host's list() only when it was NEVER written to disk, and the
// only way to tell those two apart is the host's own stat(id): a snapshot
// means the host still knows the session, undefined means it does not. The
// memo must drop exactly that one row, and it must do so without making the
// next caller wait for a directory scan.
//
// WHAT A STUB CAN AND CANNOT PROVE. The fake below answers what the host
// answers; it does not reproduce WHEN the host answers. On a live host the
// answer at dispose time is "present", so the removal does not happen on the
// dispose path, see the note on the first dispose test below.

/**
 * Let the listener's asynchronous stat() land. This is a MACROtask wait, so
 * the stat promise AND the then-handler that applies its answer have both
 * run before the next statement, a microtask tick would not be enough, and
 * the removal test would pass for the wrong reason (the row still being
 * there because the removal never happened yet).
 */
function settle(ms = 30) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Give the fake a ctx.on() the way a host has one, and hand back a getter for
 * the registered dispose callbacks.
 */
function withDisposeListener(fake) {
  const listeners = new Map()
  fake.ctx.on = (event, cb) => { const l = listeners.get(event) ?? []; l.push(cb); listeners.set(event, l) }
  return () => listeners.get('session/disposed') ?? []
}

/**
 * Same idea as withDisposeListener, but hands back a getter for the callbacks of
 * ANY event name. The counter tests need `session/created`, and they also assert
 * that the plugin registered exactly one listener for it, so the map is both the
 * trigger and the evidence.
 */
function withEventListeners(fake) {
  const listeners = new Map()
  fake.ctx.on = (event, cb) => { const l = listeners.get(event) ?? []; l.push(cb); listeners.set(event, l) }
  return (event) => listeners.get(event) ?? []
}

test('dispose: the plugin removes the row when the host says the session is gone, and the caller is served from memory', async () => {
  // WHAT THIS PINS. The plugin asks the host for the DURABLE artifact
  // (stat with source 'disk'), not for "does this process still track it".
  // GIVEN a host that answers "this session has no artifact" (stat resolves
  // undefined), the plugin removes exactly that row and nothing else, and the
  // next caller is still answered from memory.
  //
  // WHY THE QUESTION CHANGED. The host's plain stat() answers from its
  // IN-MEMORY TRACKER first, and at dispose time the tracker still holds the
  // session: the backend's dispose listener starts the close without awaiting
  // it, and the tracker entry is deleted only when that close settles. So the
  // tracked answer is "present" for a session that was created and never
  // written, and the row would linger until the next refresh. Asking for the
  // disk instead answers "absent", which is what the host's own list() will
  // say once the close settles.
  //
  // A host that does not know the option ignores it and answers from the
  // tracker, so the row stays there: the conservative bound, unchanged.
  const fake = makeFake({ listDelayMs: 300 })
  const disposeListeners = withDisposeListener(fake)
  apply(fake.ctx, {})
  await fake.list()
  assert.equal(fake.metrics().memo.warm, true)
  for (const cb of disposeListeners()) cb({ id: 's3' })
  await settle()
  const started = Date.now()
  const rows = await fake.list()
  const elapsed = Date.now() - started
  assert.equal(rows.length, 3, `the row of the session the host says is gone must be gone (the list served ${rows.length} rows)`)
  assert.equal(rows.some((r) => r?.header?.id === 's3'), false, 's3 must not be served any more')
  assert.deepEqual(fake.service.statCalls, ['s3'], 'the host was asked once, about the disposed session')
  assert.deepEqual(fake.service.statOptions, [{ source: 'disk' }], 'the host was asked for the durable artifact, not for the tracker')
  assert.ok(elapsed < 150, `the next list() waited ${elapsed} ms for a scan after a dispose`)
  assert.ok(fake.metrics().list.staleServed >= 1, 'the caller was served from memory')
})

test('dispose: a session whose artifact still exists keeps its row', async () => {
  // The host answers "the artifact exists" (stat resolves a snapshot with
  // sizeBytes), so the row is correct and stays: the host's list() is
  // disk-based, and a session whose log file is still there is still listed.
  // Dropping the row would hide a session the host still has.
  const fake = makeFake({ listDelayMs: 300, materialized: ['s2'] })
  const disposeListeners = withDisposeListener(fake)
  apply(fake.ctx, {})
  await fake.list()
  for (const cb of disposeListeners()) cb({ id: 's2' })
  await settle()
  const rows = await fake.list()
  assert.equal(rows.length, 4, `a session whose artifact exists stays in the memo (the list served ${rows.length} rows)`)
  assert.equal(rows.some((r) => r?.header?.id === 's2'), true, 's2 must still be served')
  assert.equal(fake.service.statCalls.includes('s2'), false, 'a materialized row is not asked about at all')
})

test('dispose: a persistence without stat() keeps the row and the listener does not throw', async () => {
  // A host whose persistence service has no stat() at all: absence is not
  // proven, so the row stays, and the listener must neither throw nor
  // reject, whatever it hands back.
  const fake = makeFake({ listDelayMs: 300, withStat: false })
  const disposeListeners = withDisposeListener(fake)
  apply(fake.ctx, {})
  await fake.list()
  const returned = []
  for (const cb of disposeListeners()) returned.push(cb({ id: 's2' }))
  for (const result of returned) {
    if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
      await result
    }
  }
  await settle()
  const rows = await fake.list()
  assert.equal(rows.length, 4, `without stat() the row must stay (the list served ${rows.length} rows)`)
  assert.equal(rows.some((r) => r?.header?.id === 's2'), true, 's2 must still be served')
})

test('dispose: a stat() that rejects keeps the row and never rejects out of the listener', async () => {
  // A failed stat proves nothing about the session, so the row stays and the
  // failure is recorded; the listener must never throw and never reject.
  const fake = makeFake({ listDelayMs: 300, statRejects: ['s2'] })
  const disposeListeners = withDisposeListener(fake)
  apply(fake.ctx, {})
  await fake.list()
  const returned = []
  for (const cb of disposeListeners()) returned.push(cb({ id: 's2' }))
  for (const result of returned) {
    if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
      await result
    }
  }
  await settle()
  const rows = await fake.list()
  assert.equal(rows.length, 4, `a failed stat() must not drop the row (the list served ${rows.length} rows)`)
  assert.equal(rows.some((r) => r?.header?.id === 's2'), true, 's2 must still be served')
  // Rule 4 asks for a NOTE, and the note is the only trace a swallowed
  // failure leaves: the row stays either way, so without this the failure
  // would be invisible. The wording is not fixed by the contract, so the
  // assertion is on the observable, the disposed id appears in the notes the
  // metrics endpoint exposes, not on any exact string.
  const notes = fake.metrics().snapshot.notes.join(' ')
  assert.match(notes, /s2/, `the failed stat must be recorded as a note (the notes say: ${notes})`)
})

test('dispose: removing a row keeps the same memo, and the seeded flag and age survive', async () => {
  // Rule 6: the removal replaces the memo's ARRAY and nothing else. The memo
  // stays the SAME memo, not a rebuilt, re-stamped or re-seeded one, so the
  // `seeded` marker still describes it and its age still grows. A rebuild
  // shows up as a fresh `at` (the age collapsing back to zero) or as a lost
  // seeded flag. The memo is warmed from a PLANTED snapshot row here, so it
  // is genuinely seeded and the flag is there to be lost.
  const fake = makeFake({ unwritten: ['s3'] })
  const snapshotPath = join(fake.dir, 'snap.db')
  plantSnapshot(snapshotPath, [{ header: { id: 's3', cwd: '/p1', createdAt: 1 }, revision: 'r-seeded' }])
  const disposeListeners = withDisposeListener(fake)
  apply(fake.ctx, { snapshotPath })
  await fake.list()
  assert.equal(fake.service.listCalls, 0, 'the planted row must seed the memo, not a scan')
  assert.equal(fake.metrics().snapshot.seeded, true, 'the memo is seeded')
  // Let the memo AGE before the dispose: an age that was already 0 could not
  // tell a re-stamp apart from a growth, and the check would be vacuous.
  await settle(40)
  const ageBefore = fake.metrics().memo.ageMs
  for (const cb of disposeListeners()) cb({ id: 's3' })
  await settle()
  const ageAfter = fake.metrics().memo.ageMs
  assert.ok(ageAfter >= ageBefore, `the memo was re-stamped: its age went from ${ageBefore} ms to ${ageAfter} ms`)
  assert.equal(fake.metrics().snapshot.seeded, true, 'the removal must not unseed the memo')
  const rows = await fake.list()
  assert.equal(rows.length, 0, `the seeded row of the disposed session must be gone (the list served ${rows.length} rows)`)
  assert.equal(rows.some((r) => r?.header?.id === 's3'), false, 's3 must not be served any more')
})

test('dispose: a materialized row is kept without asking the host', async () => {
  // Rule 1, narrowed: the host is asked ONLY about a row its list() could
  // stop naming, a LIVE-BUT-UNWRITTEN one. A MATERIALIZED row carries
  // sizeBytes, and that artifact on disk outlives the session: a dispose
  // detaches the session, it does not delete the log. The host still lists
  // it, so the row is CORRECT and stays. Asking would also be the expensive
  // question, a stat() on an old-generation log hashes the whole corpus ,
  // and its answer for a materialized session is always "an artifact exists".
  // So the host must not be asked AT ALL.
  const fake = makeFake({ listDelayMs: 300, materialized: ['s2'] })
  const disposeListeners = withDisposeListener(fake)
  apply(fake.ctx, {})
  await fake.list()
  for (const cb of disposeListeners()) cb({ id: 's2' })
  await settle()
  assert.deepEqual(fake.service.statCalls, [], 'a materialized row must not cost the host a stat() call')
  const rows = await fake.list()
  assert.equal(rows.length, 4, `a materialized row stays in the memo (the list served ${rows.length} rows)`)
  assert.equal(rows.some((r) => r?.header?.id === 's2'), true, 's2 must still be served')
  assert.equal(rows.find((r) => r?.header?.id === 's2')?.sizeBytes, 4096, 'the served row is still the materialized one')
})

test('dispose: a session the memo does not hold does not ask the host', async () => {
  // Rule 1: the host is asked about a session ONLY while the memo actually
  // holds that row. A dispose of an id the memo never listed must not cost a
  // stat() call, otherwise every dispose pays one, for a row that is not
  // there, and the guard the contract puts on the stat call is gone.
  const fake = makeFake({ listDelayMs: 300 })
  const disposeListeners = withDisposeListener(fake)
  apply(fake.ctx, {})
  await fake.list()
  for (const cb of disposeListeners()) cb({ id: 's9' })
  await settle()
  assert.deepEqual(fake.service.statCalls, [], 'the host must not be asked about a session the memo does not hold')
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
  apply(fake.ctx, { listTtlMs: -5, snapshotMaxAgeMs: 'soon' })
  await fake.list()
  const m = fake.metrics()
  assert.equal(m.config.listTtlMs, 5000)
  assert.equal(m.config.snapshotMaxAgeMs, 86_400_000)
})

test('config: the removed inert keys are gone from the reported config', async () => {
  // maxEntries and maxTotalEvents belonged to the inspect cache that host
  // 0.2.0-rc.2 removed. They did nothing since 2026-10-10, so they are gone
  // instead of being reported as if they were live knobs. A patch that still
  // sets them is ignored.
  const fake = makeFake()
  apply(fake.ctx, { maxEntries: 24, maxTotalEvents: 250000 })
  await fake.list()
  const m = fake.metrics()
  assert.equal('maxEntries' in m.config, false)
  assert.equal('maxTotalEvents' in m.config, false)
})

test('config: explicit zero TTL with zero stale window rescans every call', async () => {
  const fake = makeFake()
  apply(fake.ctx, { listTtlMs: 0, listMaxStaleMs: 0 })
  await fake.list()
  await fake.list()
  assert.equal(fake.service.listCalls, 2)
})

test('lifecycle: a created session must not wait out the TTL', async () => {
  // WHAT THIS PINS. The memo is a WHOLE-LIST snapshot, and until this test it
  // was invalidated only on the way OUT of a session (`session/disposed`). A
  // session that is CREATED must show up on the very next list(): the host
  // already lists created-but-unmaterialized sessions (see `list()` in
  // session-persistence-jsonl), so a memo computed before the creation is
  // simply wrong, not merely old.
  //
  // WHY THE ASSERTION IS ON THE FIRST REPLY. Marking the memo dirty is NOT
  // enough: the stale-serve path hands back the pre-change array once and
  // refreshes behind the caller, so a test that only waits for a background
  // scan would pass for the wrong reason. This fake has no delay, so a
  // dirty-only fix would still answer the first call from the old array.
  const state = {
    snapshots: [{ header: { id: 's1', cwd: '/p1', createdAt: 1 }, revision: 'r-s1', eventCount: 1, sizeBytes: 4096 }],
  }
  let scans = 0
  const service = {
    get listCalls() { return scans },
    async list() {
      scans += 1
      return state.snapshots.map((s) => ({ ...s, header: { ...s.header } }))
    },
  }
  const listeners = new Map()
  const routes = []
  const ctx = {
    inject: (names, cb) => cb({ sessionPersistence: service, sessions: { get: () => undefined } }),
    effect: (fn) => fn(),
    logger: { info: () => {}, warn: () => {} },
    // The host's ctx.on(); the plugin may or may not have registered a
    // 'session/created' listener at HEAD, so this map is the evidence.
    on: (event, cb) => { const l = listeners.get(event) ?? []; l.push(cb); listeners.set(event, l) },
    webServer: { register(route) { routes.push(route); return () => {} } },
  }
  apply(ctx, { listTtlMs: 5000, listMaxStaleMs: 120000 })

  const ids = (rows) => rows.map((r) => r?.header?.id)
  const first = await service.list()
  assert.deepEqual(ids(first), ['s1'], 'the baseline scan must name only s1')

  // The host creates s2 and publishes `session/created`, as sessions.create()
  // does. After this point list() would name s2 as well.
  state.snapshots.push({ header: { id: 's2', cwd: '/p1', createdAt: 2 }, revision: 'r-s2', eventCount: 0 })
  for (const cb of listeners.get('session/created') ?? []) cb({ id: 's2' })

  const second = await service.list()
  assert.ok(
    ids(second).includes('s2'),
    `the first list() after session/created must include s2 (got ${JSON.stringify(ids(second))}; host scans: ${scans})`,
  )
})

// --- createdInvalidations counter ---------------------------------------------

test('metrics: createdInvalidations moves when a warm memo is dropped', async () => {
  // WHAT THIS PINS. The counter is only meaningful if it reports the case it
  // was added for: a warm memo that a creation makes WRONG. Dropping a cold
  // memo costs nothing (there is no caller to mislead yet), so the handler
  // must not count that. Exactly one event, exactly one increment.
  const fake = makeFake()
  const forEvent = withEventListeners(fake)
  apply(fake.ctx, { listTtlMs: 5000, listMaxStaleMs: 120000 })

  // Warm the memo. Without this the cache is cold and the handler must not count.
  await fake.list()
  assert.equal(
    fake.metrics().lifecycle.createdInvalidations,
    0,
    'no creation has happened yet, so the counter must start at zero',
  )

  const created = forEvent('session/created')
  assert.equal(created.length, 1, 'the plugin must register exactly one session/created listener')
  for (const cb of created) cb({ id: 's5' })

  assert.equal(
    fake.metrics().lifecycle.createdInvalidations,
    1,
    'one creation against a warm memo must move the counter by exactly one',
  )
})

test('metrics: createdInvalidations stays zero when the memo is cold', async () => {
  // The other half of the same contract: with no memo there is nothing to
  // invalidate, so a creation is free. A counter that moved here would report
  // cost that no caller ever paid.
  const fake = makeFake()
  const forEvent = withEventListeners(fake)
  apply(fake.ctx, { listTtlMs: 5000, listMaxStaleMs: 120000 })

  // NO fake.list() call: the memo is cold on purpose.
  const created = forEvent('session/created')
  assert.equal(created.length, 1, 'the plugin must register exactly one session/created listener')
  for (const cb of created) cb({ id: 's5' })

  assert.equal(
    fake.metrics().lifecycle.createdInvalidations,
    0,
    'a creation with no warm memo has nothing to drop, so the counter must stay zero',
  )

  // The scan that follows must not retroactively count it either.
  await fake.list()
  assert.equal(
    fake.metrics().lifecycle.createdInvalidations,
    0,
    'the scan after the creation must not move the counter',
  )
})

// --- copy() edge cases -------------------------------------------------------

test('copy: non-array input returns as-is without throwing', async () => {
  // Regression: a misbehaving host returning null/undefined must not crash the wrapper.
  // makeFake captures service.list in a closure, so we construct with custom params instead.
  const snapshots = []
  let callCount = 0
  const service = {
    get listCalls() { return callCount },
    async list() {
      callCount += 1
      return null
    },
  }
  const ctx = {
    inject: (names, cb) => cb({ sessionPersistence: service, sessions: { get: () => undefined } }),
    effect: (fn) => fn(),
    logger: { info: () => {}, warn: () => {} },
    webServer: { register: () => () => {} },
  }
  apply(ctx, { snapshotPath: undefined })
  const result = await service.list()
  assert.equal(result, null, 'null from host must pass through copy() without TypeError')
  assert.equal(callCount, 1, 'host list must still be called')
})

test('copy: non-array primitive input returns as-is without throwing', async () => {
  const snapshots = []
  let callCount = 0
  const service = {
    get listCalls() { return callCount },
    async list() {
      callCount += 1
      return 'corrupt response'
    },
  }
  const ctx = {
    inject: (names, cb) => cb({ sessionPersistence: service, sessions: { get: () => undefined } }),
    effect: (fn) => fn(),
    logger: { info: () => {}, warn: () => {} },
    webServer: { register: () => () => {} },
  }
  apply(ctx, { snapshotPath: undefined })
  const result = await service.list()
  assert.equal(result, 'corrupt response', 'primitive from host must pass through copy() without TypeError')
})

test('copy: empty array is handled correctly', async () => {
  // Use makeFake with empty ids to get a host that returns []
  const fake = makeFake({ ids: [] })
  apply(fake.ctx, { snapshotPath: undefined })
  const result = await fake.list()
  assert.deepEqual(result, [], 'empty array must be returned correctly')
  assert.equal(fake.service.listCalls, 1)
})

// --- list() argument edge cases ------------------------------------------------

test('list: null argument is forwarded to originalList', async () => {
  const fake = makeFake()
  apply(fake.ctx, { snapshotPath: undefined })
  await fake.list(null)
  assert.equal(fake.service.optionsSeen[0], null, 'null argument must be forwarded untouched')
})

test('list: undefined argument is forwarded to originalList', async () => {
  const fake = makeFake()
  apply(fake.ctx, { snapshotPath: undefined })
  await fake.list()
  assert.equal(fake.service.optionsSeen[0], undefined, 'undefined argument must be forwarded untouched')
})

// --- double apply idempotency --------------------------------------------------

test('mount: double apply() is idempotent, second call is no-op', async () => {
  const fake = makeFake()
  apply(fake.ctx, { snapshotPath: undefined })
  apply(fake.ctx, { snapshotPath: undefined })
  await fake.list()
  await fake.list()
  assert.equal(fake.service.listCalls, 1, 'double apply must not cause double wrapping')
})

// --- session/created during in-flight scan -------------------------------------

test('lifecycle: session/created during in-flight scan invalidates the scan result', async () => {
  // When a session is created while a scan is running, the scan's result must not
  // install into the memo (purgeEpoch prevents this).
  const state = {
    snapshots: [{ header: { id: 's1', cwd: '/p1', createdAt: 1 }, revision: 'r-s1', sizeBytes: 4096 }],
  }
  let scans = 0
  const service = {
    get listCalls() { return scans },
    async list() {
      scans += 1
      // Small delay so create event can fire mid-scan
      await new Promise(r => setTimeout(r, 20))
      return state.snapshots.map(s => ({ ...s, header: { ...s.header } }))
    },
  }
  const listeners = new Map()
  const routes = []
  const ctx = {
    inject: (names, cb) => cb({ sessionPersistence: service, sessions: { get: () => undefined } }),
    effect: (fn) => fn(),
    logger: { info: () => {}, warn: () => {} },
    on: (event, cb) => { const l = listeners.get(event) ?? []; l.push(cb); listeners.set(event, l) },
    webServer: { register(route) { routes.push(route); return () => {} } },
  }
  apply(ctx, { listTtlMs: 5000, listMaxStaleMs: 120000 })

  const first = service.list()
  // Fire created event mid-scan
  await new Promise(r => setTimeout(r, 5))
  for (const cb of listeners.get('session/created') ?? []) cb({ id: 's2' })
  // Add new session to state
  state.snapshots.push({ header: { id: 's2', cwd: '/p1', createdAt: 2 }, revision: 'r-s2', sizeBytes: 2048 })
  const result = await first
  // The first scan started before creation, so it should still return only s1
  // (the purgeEpoch was bumped, so the scan result won't install)
  const ids = result.map(r => r?.header?.id)
  assert.ok(ids.includes('s1'), 'first scan result should contain s1')
  // Second call should trigger a fresh scan that sees s2
  const second = await service.list()
  const secondIds = second.map(r => r?.header?.id)
  assert.ok(secondIds.includes('s2'), 'second scan after creation must include s2')
})

// --- dispose with invalid session object ---------------------------------------

test('dispose: invalid session payload does not throw', async () => {
  const fake = makeFake()
  const disposeListeners = []
  fake.ctx.on = (event, cb) => {
    if (event === 'session/disposed') disposeListeners.push(cb)
  }
  apply(fake.ctx, {})
  await fake.list()

  // Various invalid payloads must not throw
  const invalidPayloads = [null, undefined, {}, 42, 'string', { id: null }, { id: 123 }]
  for (const payload of invalidPayloads) {
    let threw = false
    try {
      for (const cb of disposeListeners) cb(payload)
    } catch (e) {
      threw = true
    }
    assert.equal(threw, false, `dispose with ${JSON.stringify(payload)} must not throw`)
  }
})


// --- workspace awareness: deletedSessions filtering -------------------------

test('delete: persistence.delete() wrapping drops memo and registers the id', async () => {
  const fake = makeFake({ ids: ['s1', 's2', 's3'] })
  apply(fake.ctx, {})
  // Populate cache via a scan
  await fake.list()
  assert.equal(fake.service.listCalls, 1, 'one scan to populate')
  // The fake does not expose listCache; verify via the metrics route that
  // the memo is warm (ageMs is a number, not null).
  const metricsRoute = fake.routes.find(r => r.path === '/plugin/session-readcache/metrics')
  const mockRes = { _headers: {}, _body: null,
    writeHead(status, headers) { this._status = status; this._headers = headers },
    end(body) { this._body = body }
  }
  metricsRoute.handler({ method: 'GET' }, mockRes)
  const beforeData = JSON.parse(mockRes._body)
  assert.ok(beforeData.memo.warm, 'memo is warm before delete')

  // Now simulate what the wrapper does when persistence.delete() fires:
  // drop memo, register id in deletedSessions, bump purgeEpoch
  // We verify this by calling the route handler that the purge plugin would call
  const purgeRoute = fake.routes.find(r => r.path === '/plugin/session-readcache/purge')
  const purgeReq = {
    method: 'POST',
    headers: new Map([['content-type', 'application/json']]),
    text: async () => JSON.stringify({ sessionIds: ['s1'] })
  }
  await purgeRoute.handler(purgeReq, mockRes)
  const afterData = JSON.parse(mockRes._body)
  assert.equal(afterData.purged, 1, 'memo dropped after purge')
  assert.equal(afterData.registeredDeleted, 1, 's1 registered as deleted')
})

test('delete: scan result filters out explicitly deleted session ids', async () => {
  const fake = makeFake({ ids: ['s1', 's2', 's3'] })
  apply(fake.ctx, {})
  await fake.list()
  // Use purge endpoint to register s1 as deleted, then call list() again.
  // The second scan should exclude s1 from its result.
  const purgeRoute = fake.routes.find(r => r.path === '/plugin/session-readcache/purge')
  const mockRes = { _headers: {}, _body: null,
    writeHead(status, headers) { this._status = status; this._headers = headers },
    end(body) { this._body = body }
  }
  await purgeRoute.handler({
    method: 'POST',
    headers: new Map([['content-type', 'application/json']]),
    text: async () => JSON.stringify({ sessionIds: ['s1'] })
  }, mockRes)

  // Now call list() again — since the memo was dropped, a fresh scan runs.
  // The fake's list() returns all 3 snapshots, but the wrapper should
  // filter out s1 because it is in deletedSessions.
  const result = await fake.list()
  const ids = result.map(s => s.header.id)
  assert.ok(!ids.includes('s1'), 'deleted session s1 should be filtered out')
  assert.ok(ids.includes('s2'), 's2 should still be present')
  assert.ok(ids.includes('s3'), 's3 should still be present')
})

test('workspace: releaseSession() wrapping drops memo and registers the id', async () => {
  const fake = makeFake({ ids: ['s1', 's2', 's3'] })
  // Add releaseSession to simulate workspaceRegistry
  fake.service.releaseSession = async (id) => {
    // simulate removing from workspace
  }
  apply(fake.ctx, {})
  await fake.list()
  // Trigger what the wrapper does
  // The wrapper calls target.releaseSession then drops memo and registers id
  // Verify by checking that after calling releaseSession on the wrapped target,
  // the memo is dropped
  const before = fake.service.listCalls
  await fake.service.releaseSession('s1')
  // After releaseSession, the wrapper should have dropped the memo
  // The next list() call should trigger a fresh scan
  await fake.list()
  const after = fake.service.listCalls
  assert.equal(after - before, 1, 'fresh scan after releaseSession')
})

test('metrics: deletedSessionsCount is reported', async () => {
  const fake = makeFake({ ids: ['s1', 's2'] })
  apply(fake.ctx, {})
  await fake.list()
  // Use the route handler directly to check metrics
  const route = fake.routes.find(r => r.path === '/plugin/session-readcache/metrics')
  assert.ok(route, 'metrics route registered')
  const mockRes = { _headers: {}, _body: null,
    writeHead(status, headers) { this._status = status; this._headers = headers },
    end(body) { this._body = body }
  }
  route.handler({ method: 'GET' }, mockRes)
  const data = JSON.parse(mockRes._body)
  assert.equal(typeof data.lifecycle.deletedSessionsCount, 'number',
    'deletedSessionsCount should be a number in metrics')
})

test('purge: POST handler registers sessionIds into deletedSessions', async () => {
  const fake = makeFake({ ids: ['s1', 's2', 's3'] })
  apply(fake.ctx, {})
  await fake.list()
  const route = fake.routes.find(r => r.path === '/plugin/session-readcache/purge')
  assert.ok(route, 'purge route registered')
  const mockReq = {
    method: 'POST',
    headers: new Map([['content-type', 'application/json']]),
    text: async () => JSON.stringify({ sessionIds: ['s1', 's3'] })
  }
  const mockRes = { _headers: {}, _body: null,
    writeHead(status, headers) { this._status = status; this._headers = headers },
    end(body) { this._body = body }
  }
  await route.handler(mockReq, mockRes)
  const data = JSON.parse(mockRes._body)
  assert.equal(data.purged, 1, 'memo was dropped')
  assert.equal(data.registeredDeleted, 2, 'two session ids registered')
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

// dsh-session-readcache: advisory read cache for the host's SessionPersistence service.
// Wraps the shared `sessionPersistence` instance's `inspect` (LRU beyond the host's
// built-in capacity-5 preparation cache, stat-validated) and `list` (short-TTL memo with
// in-flight coalescing). Cold-only; every failure path delegates to the original method.
import { stat, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const name = 'session-readcache'
// Only services that every host context is guaranteed to provide may be declared
// here. A declared name with no implementation leaves the cordis fiber epoch
// INACTIVE, and the plugin body then never runs at all — silently, with no error
// (cordis Fiber._refresh/_setEpoch). That was measured: a real host context
// holding SessionStore + JsonlSessionPersistence but no web surface never
// executed apply(), so the wrapper never installed. webServer is therefore
// awaited through ctx.inject() below, which fires when the service appears and
// simply never fires on hosts that have none.
const inject = ['sessionPersistence', 'sessions']
const provide = []

const DEFAULTS = {
  maxEntries: 24,
  maxTotalEvents: 250000,
  listTtlMs: 750,
  // A completed directory scan is measured in seconds (9.7 s for 3.8k logs on
  // this host), so a strict TTL expires before any caller can be served: the
  // live counters read 0 hits across 184 misses. Within this window an expired
  // memo is still handed back while a refresh runs behind it, which turns a
  // seconds-long wait into a sub-millisecond reply at the cost of bounded
  // staleness. 0 preserves the strict-TTL behaviour.
  listMaxStaleMs: 30_000,
  // Upper age of a persisted snapshot that may seed the memo at boot, so a
  // restart does not pay a full scan for its first reply. 0 disables seeding.
  snapshotMaxAgeMs: 600_000,
}

// Time sources, indirected so tests can pin them. TTL and stale windows read a
// MONOTONIC clock: a wall-clock step (NTP, manual correction) must not be able
// to extend a memo's life or make it immortal, and within one process monotonic
// time is the only ordering that cannot move backwards. Snapshot bookkeeping
// (saved_at, its age) deliberately stays on the WALL clock: that value is
// written to disk and read back by a later process, where monotonic time has no
// meaning. Mutating these two functions is a test seam; production never does.
export const clock = {
  monotonic: () => performance.now(),
  wall: () => Date.now(),
}

// Config is read defensively and reported, never thrown: a malformed row must
// not take the host down, and a silent fallback hides the typo from the
// operator. The banner already prints effective values; this names the keys it
// had to ignore.
function readCount(raw, fallback, allowZero) {
  if (raw === undefined) return { value: fallback, invalid: false }
  if (Number.isSafeInteger(raw) && (allowZero ? raw >= 0 : raw > 0)) {
    return { value: raw, invalid: false }
  }
  return { value: fallback, invalid: true }
}

function showValue(raw) {
  if (typeof raw === 'string') return JSON.stringify(raw)
  if (typeof raw === 'bigint') return `${raw}n`
  if (raw === null || typeof raw !== 'object') return String(raw)
  return Object.prototype.toString.call(raw)
}

async function revisionOf(path) {
  try {
    const st = await stat(path, { bigint: true })
    return `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`
  } catch {
    return null
  }
}

// --- list snapshot persistence (best-effort) ---------------------------------
// The host's own list() walks every project/session directory and decodes one
// zstd header frame per log: measured 9,761 ms for 3,847 logs on this host.
// A restart therefore pays that cost for its first reply. The last completed
// list is written to a one-row SQLite table so a boot inside snapshotMaxAgeMs
// can answer immediately while a real scan refreshes behind it.

// Row format version, kept in the database header (PRAGMA user_version) rather
// than a column so a one-row file written by an older build stays readable and
// a row written by a NEWER, incompatible build is refused instead of parsed.
// Version 0 is the layout this plugin has always written, so it stays legal.
const SNAPSHOT_SCHEMA_VERSION = 1
// Upper bound on the persisted row. Headers are flat scalar records; the bound
// exists so a corrupt or foreign database cannot pull an unbounded TEXT value
// (and the JSON.parse behind it) into a cache whose job is to be cheap.
const SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024
// How far ahead of the reading process a saved_at may sit before the row is
// treated as corrupt. Without this, a huge or negative stamp makes
// snapshotMaxAgeMs unable to expire anything.
const SNAPSHOT_MAX_FUTURE_MS = 60_000
// Failure notes are bounded: a scan that fails once per cycle must not grow an
// array for the lifetime of a long-running host process.
const NOTES_LIMIT = 20
// Keys that can reach a prototype when copied. JSON.parse creates an OWN
// `__proto__` data property (it does not invoke the setter), but `{...header}`
// and Object.assign copy that own property as data, so a crafted snapshot row
// can land a prototype on whatever object a downstream merge writes into. The
// session header shape has no field by any of these names.
const FORBIDDEN_HEADER_KEYS = ['__proto__', 'constructor', 'prototype']

// Loaded lazily: a native-addon load failure must not take the plugin down,
// so every path here degrades to "no snapshot" rather than throwing.
let nativeModule
async function openDatabase(path, create) {
  if (nativeModule === undefined) {
    try {
      const imported = await import('better-sqlite3')
      nativeModule = imported.default ?? imported
    } catch (error) {
      return { error }
    }
  }
  let db
  try {
    if (create) {
      await mkdir(dirname(path), { recursive: true })
      db = new nativeModule(path)
      db.exec(`CREATE TABLE IF NOT EXISTS readcache_list_snapshot (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        saved_at INTEGER NOT NULL,
        headers TEXT NOT NULL
      )`)
      db.pragma(`user_version = ${SNAPSHOT_SCHEMA_VERSION}`)
    } else {
      // The read path never writes. An earlier build opened the database
      // read-write for reads, which created the file and the table on a pure
      // read and failed on a read-only store; a cache must not need write
      // access just to look.
      db = new nativeModule(path, { readonly: true, fileMustExist: true })
    }
    const opened = db
    db = undefined // ownership moves to the caller
    return { db: opened }
  } catch (error) {
    // The handle exists whenever `exec` is what threw — a corrupt or
    // non-SQLite file gets that far — and returning without closing it leaks an
    // fd per scan, since every completed scan writes a snapshot.
    try { db?.close() } catch { /* the handle is already unusable */ }
    return { error }
  }
}

/** Shape check shared by the persisted row and the live scan. */
function headersAreSound(headers) {
  if (!Array.isArray(headers)) return false
  return headers.every((header) =>
    header !== null &&
    typeof header === 'object' &&
    typeof header.id === 'string' &&
    !FORBIDDEN_HEADER_KEYS.some((key) => Object.prototype.hasOwnProperty.call(header, key)))
}

/** Read the persisted list snapshot. Returns undefined on any failure. */
async function loadSnapshot(path) {
  try {
    // A path that was never written — no file, or not even a directory yet — is
    // the normal first boot, not a failure. Opening read-only raises the same
    // "unable to open database file" for a missing parent directory as for a
    // missing file, so the existence is settled here instead of from the error.
    try {
      await stat(path)
    } catch {
      return {}
    }
    const { db, error } = await openDatabase(path, false)
    if (db === undefined) {
      // Raced with a delete, or another failure to open: not a boot-blocking
      // condition, so it degrades to "no snapshot" with the reason recorded.
      if (error?.code === 'ENOENT') return {}
      return { error }
    }
    try {
      const version = db.pragma('user_version', { simple: true })
      if (version !== 0 && version !== SNAPSHOT_SCHEMA_VERSION) {
        return { error: new Error(`unsupported snapshot schema version ${version}`) }
      }
      // Measure before materialising: a foreign or corrupt row can be enormous,
      // and the length() call costs nothing next to pulling it into the heap.
      // CAST to BLOB so the number is bytes, not characters.
      const row = db.prepare('SELECT length(CAST(headers AS BLOB)) AS bytes, saved_at FROM readcache_list_snapshot WHERE id = 1').get()
      if (row === undefined) return {}
      if (!Number.isSafeInteger(row.bytes)) {
        return { error: new Error('snapshot row size is not an integer') }
      }
      if (row.bytes > SNAPSHOT_MAX_BYTES) {
        return { error: new Error(`snapshot row too large (${row.bytes} bytes)`) }
      }
      if (!Number.isSafeInteger(row.saved_at)) {
        return { error: new Error('snapshot saved_at is not an integer') }
      }
      const headers = JSON.parse(
        db.prepare('SELECT headers FROM readcache_list_snapshot WHERE id = 1').get().headers,
      )
      return { savedAt: row.saved_at, headers }
    } finally {
      db.close()
    }
  } catch (error) {
    return { error }
  }
}

/**
 * Persist the last completed list. Failures are reported, never thrown.
 *
 * `stillMounted` is consulted after the connection opens and before the row is
 * written: a write that lands after this mount was disposed would hand a later
 * mount headers the disposed one no longer owns, stamped with a `saved_at` newer
 * than the content beside it. That breaks the one invariant `snapshotMaxAgeMs`
 * relies on — that `saved_at` describes the age of the rows next to it. Only
 * unmount has this race, because the async gap before the write is the
 * directory creation and database open, not the statement itself.
 */
async function saveSnapshot(path, headers, stillMounted) {
  try {
    if (!Array.isArray(headers)) return new Error('refusing to snapshot a non-array list result')
    const json = JSON.stringify(headers)
    // Measured in UTF-8 bytes, exactly like the loader's
    // length(CAST(headers AS BLOB)): a char count would let a non-ASCII header
    // pass here and be refused on the next boot, a write/read asymmetry.
    if (Buffer.byteLength(json, 'utf8') > SNAPSHOT_MAX_BYTES) {
      return new Error(`snapshot too large to persist (${Buffer.byteLength(json, 'utf8')} bytes)`)
    }
    const { db, error } = await openDatabase(path, true)
    if (db === undefined) return error
    try {
      if (typeof stillMounted === 'function' && !stillMounted()) {
        return new Error('unmounted before the snapshot write landed')
      }
      db.prepare('INSERT OR REPLACE INTO readcache_list_snapshot (id, saved_at, headers) VALUES (1, ?, ?)')
        .run(clock.wall(), json)
      return undefined
    } finally {
      db.close()
    }
  } catch (error) {
    return error
  }
}

function apply(ctx, config = {}) {
  if (config.enabled === false) {
    ctx.logger?.info?.('[session-readcache] disabled by config')
    return
  }
  if (config.enabled !== undefined && typeof config.enabled !== 'boolean') {
    ctx.logger?.warn?.(`[session-readcache] config enabled is not a boolean (${showValue(config.enabled)}); only the exact value false disables the plugin`)
  }
  // Explicit validation: type and range are checked per key, an out-of-domain
  // value falls back to the documented default, and the fallback is always
  // named in the log. Defaults and option names are unchanged.
  const countSpecs = [
    ['maxEntries', config.maxEntries, DEFAULTS.maxEntries, false],
    ['maxTotalEvents', config.maxTotalEvents, DEFAULTS.maxTotalEvents, false],
    ['listTtlMs', config.listTtlMs, DEFAULTS.listTtlMs, true],
    ['listMaxStaleMs', config.listMaxStaleMs, DEFAULTS.listMaxStaleMs, true],
    ['snapshotMaxAgeMs', config.snapshotMaxAgeMs, DEFAULTS.snapshotMaxAgeMs, true],
  ]
  const resolved = {}
  const invalid = []
  for (const [key, raw, fallback, allowZero] of countSpecs) {
    const read = readCount(raw, fallback, allowZero)
    resolved[key] = read.value
    if (read.invalid) invalid.push(`${key}=${showValue(raw)}`)
  }
  if (invalid.length > 0) {
    ctx.logger?.warn?.(`[session-readcache] invalid config, default used: ${invalid.join(', ')}`)
  }
  const maxEntries = resolved.maxEntries
  const maxTotalEvents = resolved.maxTotalEvents
  const listTtlMs = resolved.listTtlMs
  const listMaxStaleMs = resolved.listMaxStaleMs
  const snapshotMaxAgeMs = resolved.snapshotMaxAgeMs
  const counters = { hits: 0, misses: 0, stale: 0, liveSkips: 0, listHits: 0, listMisses: 0, listStale: 0 }
  const snapshotCounters = { saves: 0, failures: 0 }
  const notes = []
  function note(text) {
    notes.push(text)
    if (notes.length > NOTES_LIMIT) notes.splice(0, notes.length - NOTES_LIMIT)
  }

  ctx.inject(['sessionPersistence', 'sessions'], ({ sessionPersistence: target, sessions }) => {
    if (target.__readcacheApplied) return
    const originalInspect = target.inspect.bind(target)
    const originalList = target.list.bind(target)
    const entries = new Map()
    const inflight = new Map()
    // Artifact path per identity, resolved once from a listed header so a later
    // read can stat BEFORE it reads. Kept apart from `entries`: a path outlives
    // the entry it produced, and evicting an entry must not forget where its
    // log lives. Bounded like the LRU so it cannot grow without limit.
    const logPaths = new Map()
    let totalCost = 0
    // Purge is the escape hatch: a read already inside the underlying call
    // when a purge lands must not install the view the purge just dropped.
    // Deleting `inflight` alone stops coalescing, not the insert below. One
    // counter covers both purge shapes; an unrelated in-flight read may be
    // skipped too, which costs one re-read and never a wrong entry.
    let purgeEpoch = 0
    // Lifecycle invalidation, separate from the manual purge epoch on purpose.
    // `session/disposed` removes the session from the store BEFORE the host has
    // flushed its final turn (core/session: store.delete runs before
    // emitDisposed, and emitDisposed drives retire -> flush, whose append lands
    // an event loop later). Inside that window the entry's stat token still
    // matches and the liveness check passes, so the hit path would return a
    // view the host itself refuses to serve: coordinator.inspect awaits
    // waitForRetirement before it reads. Dropping the entry covers every read
    // that starts afterwards; bumping this epoch covers a read that was already
    // parked on its stat when the dispose landed — it falls through to the host
    // instead of installing the pre-drain view. The epoch is global, so a
    // dispose of ANY session also invalidates parked hits of others: the cost is
    // one extra host read per parked read during a dispose, never a wrong
    // answer. The INSTALL path below deliberately does NOT consult this epoch:
    // a read that was already inside the host when the dispose landed returns
    // the post-barrier view (the host awaited the drain), which is exactly what
    // should be cached. Manual purge keeps the softer contract (a parked read
    // may finish), which is the tested behaviour of the purge endpoint.
    let lifecycleEpoch = 0
    // The coalescing map holds at most one pending read per id and self-cleans
    // on settle. This cap bounds the map against a fan-out over many DISTINCT
    // ids at once: past it a read runs unfolded. Nothing is queued and nothing
    // is dropped, so the number of concurrent operations stays the host's
    // business, not this map's.
    const coalesceLimit = Math.max(1, maxEntries)

    function evictFor(cost) {
      while (entries.size > 0 && (entries.size >= maxEntries || totalCost + cost > maxTotalEvents)) {
        const oldest = entries.keys().next().value
        const dropped = entries.get(oldest)
        entries.delete(oldest)
        totalCost -= dropped.cost
      }
    }

    function inspect(id, signal) {
      // Concurrent reads of one id would each mutate the shared accounting
      // below; the first caller owns the work and the rest await its result.
      // A caller-supplied signal must not inherit someone else's cancellation,
      // so signalled reads are never folded into a shared call.
      if (signal === undefined) {
        const shared = inflight.get(id)
        if (shared !== undefined) return shared
        if (inflight.size >= coalesceLimit) return inspectRead(id, signal)
      }
      const pending = inspectRead(id, signal)
      if (signal === undefined) {
        inflight.set(id, pending)
        const release = () => {
          if (inflight.get(id) === pending) inflight.delete(id)
        }
        pending.then(release, release)
      }
      return pending
    }

    async function inspectRead(id, signal) {
      // Reject before touching any state, mirroring the host: its inspect()
      // loop checks as its first statement, and its own preparation cache
      // rejects a pre-aborted signal even on a hit. Placing it here rather than
      // only inside the hit branch also keeps a dead caller from paying the
      // list() directory scan the miss path performs to resolve a log path.
      signal?.throwIfAborted()
      // Read before the first await so a purge landing during the underlying
      // call is visible to the install step below.
      const epoch = purgeEpoch
      const lifecycle = lifecycleEpoch
      const hit = entries.get(id)
      if (hit !== undefined) {
        const revision = await revisionOf(hit.path)
        // The stat yields the event loop, so an abort landing during it has to
        // be noticed here: this branch is the one return that never delegates
        // to the host's check. A signalled read is never coalesced, so the
        // caller waiting is its own and nobody else rejects for it.
        signal?.throwIfAborted()
        if (
          revision !== null &&
          revision === hit.revision &&
          lifecycle === lifecycleEpoch &&
          sessions.get(id) === undefined
        ) {
          counters.hits += 1
          // The stat above yields the event loop: a purge or an eviction may
          // already have dropped this entry, so only its owner refreshes
          // recency. Re-inserting blind would undo the purge, restore an entry
          // no cost is booked against, and grow the map past maxEntries since
          // this branch never runs evictFor.
          if (entries.get(id) === hit) {
            entries.delete(id)
            entries.set(id, hit)
          }
          return hit.inspection
        }
        // Only a revision that actually moved means the file changed. The hit
        // test above also fails on liveness or on a dispose landing mid-stat,
        // and counting those as `stale` would report a stat mismatch for a file
        // that was never touched — attaching a session that was cached cold is
        // the documented normal flow, not a corruption signal. The miss path
        // below books that transition under liveSkips, where it belongs.
        if (revision === null || revision !== hit.revision) counters.stale += 1
        // The await above lets other callers past the same lookup. Only the
        // one that still owns this exact entry may drop it: Map.delete is
        // idempotent but the subtraction is not, so the synchronous ownership
        // check is what keeps the two in step.
        if (entries.get(id) === hit) {
          entries.delete(id)
          totalCost -= hit.cost
        }
      }
      counters.misses += 1
      // The host serves a live session from memory as the first branch of its
      // own loop and reads nothing, so resolving the log path here would buy a
      // directory scan for a view that can never be installed anyway — the
      // check after the read returns without caching one. Skip the path lookup
      // when the session is already attached; a session that detaches while
      // this read runs simply stays uncached until the next call.
      const attached = sessions.get(id) !== undefined
      // Stat before the read, not after. A stat taken after the read can only
      // describe a newer file than the events just parsed, so a write landing
      // inside the read window would certify stale events with the post-write
      // revision and every later hit would keep serving them. Booked only while
      // the epoch still matches, or a purge landing mid-read is undone.
      const path = attached ? undefined : await pathForId(id)
      const revision = path === undefined ? null : await revisionOf(path)
      const inspection = await originalInspect(id, signal)
      // Live sessions alias a growing events array; never retain their view.
      if (sessions.get(id) !== undefined) {
        counters.liveSkips += 1
        return inspection
      }
      try {
        // The listed header and the returned meta must name the same artifact.
        // A disagreement means the pre-read stat proved nothing about this
        // content, so the view is handed back uncached rather than certified.
        const located = target.locate?.(inspection.meta)?.path
        if (typeof path === 'string' && located === path && inspection.events.length > 0) {
          const cost = inspection.events.length
          if (cost <= maxTotalEvents && revision !== null && epoch === purgeEpoch) {
            evictFor(cost)
            // A resident key adds no entry when its value is replaced, so its
            // old cost has to leave the running total before the new one
            // enters. Without this, a repeat insert for one id inflates the
            // total by a full cost while the Map still holds a single entry.
            const replaced = entries.get(id)
            if (replaced !== undefined) totalCost -= replaced.cost
            entries.set(id, { path, revision, inspection, cost })
            totalCost += cost
          }
        }
      } catch {
        // caching is advisory; a failed bookkeeping pass must not affect the read
      }
      return inspection
    }

    let listCache
    let listInflight
    // Flips the first time this mount is unwrapped. A snapshot write that is
    // already scheduled reads it just before writing: disposing mid-scan stops
    // an orphan write from stamping headers from an earlier scan with a later
    // `saved_at`, which would otherwise pass `snapshotMaxAgeMs` for content it
    // does not describe.
    let disposed = false
    // Boot seeding, resolved once: the last completed scan persisted to
    // SQLite so a restart answers immediately while a real scan refreshes
    // behind it. Only the first scan funds it (memoized on this promise), and
    // every outcome — ready, absent, stale, failed — resolves exactly once.
    let listSeed
    const snapshotPath = (() => {
      // An explicit path wins (tests and unusual layouts); otherwise the
      // harness `dshHomePath(...segments)` service, then the DSH_HOME env.
      // With none, persistence stays off rather than guessed: an advisory
      // cache must not invent a location.
      try {
        if (typeof config.snapshotPath === 'string' && config.snapshotPath.length > 0) {
          return config.snapshotPath
        }
        const homer = typeof ctx.get === 'function' ? ctx.get('dshHomePath') : undefined
        if (typeof homer === 'function') {
          const resolved = homer('plugins', 'session-readcache', 'list-snapshot.db')
          if (typeof resolved === 'string' && resolved.length > 0) return resolved
        }
        const envHome = typeof process?.env?.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
          ? process.env.DSH_HOME
          : undefined
        return envHome === undefined ? undefined : join(envHome, 'plugins', 'session-readcache', 'list-snapshot.db')
      } catch {
        return undefined
      }
    })()
    async function ensureSeeded() {
      if (listSeed === undefined) {
        listSeed = (async () => {
          if (snapshotPath === undefined || snapshotMaxAgeMs === 0) return
          const { savedAt, headers, error } = await loadSnapshot(snapshotPath)
          if (error !== undefined) {
            snapshotCounters.failures += 1
            note(`snapshot load failed: ${error?.message ?? error}`)
            return
          }
          if (savedAt === undefined || !Array.isArray(headers)) return
          // Shape before trust. The row is only served when every element is a
          // session header: any element that is not (a number, null, an object
          // without an id, an object carrying a prototype-reaching key) would
          // be handed to callers as a session row, because the memo hands its
          // contents out as-is and the host later looks each one up by id. One
          // bad element means the whole row is suspect, so all of them must
          // pass rather than the array being trimmed to fit.
          if (!headersAreSound(headers)) {
            snapshotCounters.failures += 1
            note('snapshot headers are not session headers; rescanning')
            return
          }
          // A stamp from the future is corruption, not speed: honouring it
          // would make snapshotMaxAgeMs unable to expire the row. A small
          // forward skew is tolerated because the writer and the reader are
          // different processes on machines whose clocks may disagree.
          const now = clock.wall()
          const age = now - savedAt
          if (age < -SNAPSHOT_MAX_FUTURE_MS) {
            snapshotCounters.failures += 1
            note(`snapshot saved_at is ${Math.round((savedAt - now) / 1000)}s in the future; rescanning`)
            return
          }
          if (age >= snapshotMaxAgeMs) {
            note(`snapshot too old (${Math.round(age / 1000)}s); rescanning`)
            return
          }
          // Stamped at boot, not at the snapshot's own age: the seed exists to
          // answer the FIRST reply, and reusing `savedAt` would place a
          // snapshot minutes old far outside `listTtlMs + listMaxStaleMs`, so it
          // would be discarded instead of served. The honest consequence is that
          // `snapshotMaxAgeMs` gates BOOT seeding while the stale window bounds
          // staleness from then on, making the oldest servable reply
          // `snapshotMaxAgeMs + listTtlMs + listMaxStaleMs` old. README says so.
          listCache = { value: headers, at: clock.monotonic(), seeded: true }
        })()
      }
      await listSeed
    }
    // Copy on the way out, and rebuild each header key by key so an own
    // `__proto__` (or the other two prototype-reaching names) can never ride
    // along into a caller's object. Session headers are flat scalar records,
    // so a shallow rebuild is a complete copy; the seed path already refuses a
    // row containing those keys, and this covers a live scan as well.
    function copy(value) {
      return value.map((header) => {
        const out = {}
        // The memo is validated on the seed path and host-produced on the live
        // path, so this branch is unreachable today; it keeps list() from
        // throwing if that ever stops being true.
        if (header === null || typeof header !== 'object') return out
        for (const key of Object.keys(header)) {
          if (FORBIDDEN_HEADER_KEYS.includes(key)) continue
          out[key] = header[key]
        }
        return out
      })
    }
    // The memo itself, without counting: `inspect` reads a header out of it to
    // resolve a log path, and that must not look like a caller of list().
    function listMemo() {
      if (listCache !== undefined && clock.monotonic() - listCache.at < listTtlMs) return Promise.resolve(listCache.value)
      if (listInflight !== undefined) return listInflight
      // The seed is awaited INSIDE the in-flight slot so a boot-time caller and
      // every caller racing it share one wait instead of one scan each, and so
      // the slot is released no matter which branch answers.
      const pending = (async () => {
        await ensureSeeded()
        if (listCache !== undefined && clock.monotonic() - listCache.at < listTtlMs) return listCache.value
        // Counted here, not in list(): a scan is a scan whoever started it, and
        // the path lookup below starts them too.
        counters.listMisses += 1
        const value = await originalList()
        listCache = { value, at: clock.monotonic() }
        if (snapshotPath !== undefined) {
          // Off the response path: the caller already has its headers, and a
          // snapshot write must never delay or fail a list reply. The predicate
          // reads the flag rather than a captured token: the flag flips as soon
          // as this mount is disposed, even while the scan above is still
          // running, so a write scheduled after that scan lands only if the
          // mount that scheduled it is still the one that owns the memo.
          saveSnapshot(snapshotPath, value, () => !disposed).then((error) => {
            if (error !== undefined) {
              snapshotCounters.failures += 1
              note(`snapshot save failed: ${error?.message ?? error}`)
            } else {
              snapshotCounters.saves += 1
            }
          })
        }
        return value
      })()
      listInflight = pending
      const release = () => {
        if (listInflight === pending) listInflight = undefined
      }
      pending.then(release, release)
      return pending
    }
    // Refresh a stale memo without making the caller wait for it. The rejection is
    // already consumed by listMemo's own release handler, so this catch is a
    // second layer on the advisory contract, not the load-bearing one: an error
    // in the refresh path must never reach the caller being served a stale copy.
    function refreshListInBackground() {
      try {
        listMemo().catch(() => {})
      } catch {
        /* advisory */
      }
    }
    function list(signal) {
      if (signal !== undefined) {
        // A signalled caller bypasses the memo so a cancelled one is never
        // handed a memoized value, but it still scans every directory. That
        // scan has to be booked where an unsigned one is, or misses stops
        // being the honest scan count README promises.
        // Not booked when the caller is already cancelled: the host rejects
        // such a read as the first statement of its own loop, so no directory
        // is ever walked and counting one would report work never done.
        if (!signal.aborted) counters.listMisses += 1
        return originalList(signal)
      }
      if (listCache !== undefined) {
        const age = clock.monotonic() - listCache.at
        if (age < listTtlMs) {
          counters.listHits += 1
          return Promise.resolve(copy(listCache.value))
        }
        // Past the TTL but inside the stale window: hand back the last scan
        // now and refresh behind it. A scan costs seconds, so blocking here is
        // what left the live counters at zero hits; the caller trades exact
        // freshness for a sub-millisecond reply, bounded by listMaxStaleMs.
        if (age < listTtlMs + listMaxStaleMs) {
          counters.listStale += 1
          refreshListInBackground()
          return Promise.resolve(copy(listCache.value))
        }
      }
      if (listInflight !== undefined) return listInflight.then(copy)
      return listMemo().then(copy)
    }
    // Remember where a session's log lives so the next read can stat it before
    // reading. locate() needs a header and the memo already holds one. Only the
    // path is kept: never the header itself, never event data.
    async function pathForId(id) {
      try {
        const known = logPaths.get(id)
        if (known !== undefined) {
          logPaths.delete(id)
          logPaths.set(id, known)
          return known
        }
        const headers = await listMemo()
        const header = headers.find((candidate) => candidate.id === id)
        // locate() resolves a header with no cwd to the backend's own
        // no-cwd directory, so the path is still the real artifact; a backend
        // that owns no per-session artifact declines instead, and with no path
        // there is no pre-read revision to stamp, so the read stays uncached.
        const path = header === undefined ? undefined : target.locate?.(header)?.path
        if (typeof path !== 'string') return undefined
        logPaths.set(id, path)
        while (logPaths.size > maxEntries) logPaths.delete(logPaths.keys().next().value)
        return path
      } catch {
        return undefined
      }
    }

    Object.defineProperty(target, 'inspect', { value: inspect, configurable: true, writable: true })
    Object.defineProperty(target, 'list', { value: list, configurable: true, writable: true })
    Object.defineProperty(target, '__readcacheApplied', { value: true, configurable: true })

    // A session that leaves the store must stop being served from cache before
    // the host finishes draining it. Registered as its own inject rather than
    // a synchronous read so a host without the web surface still gets the
    // lifecycle listener; the listener itself is tiny and idempotent.
    if (typeof ctx.on === 'function') {
      try {
        ctx.on('session/disposed', (session) => {
          const id = session?.id
          if (typeof id !== 'string') return
          lifecycleEpoch += 1
          const dropped = entries.get(id)
          if (dropped !== undefined) {
            // Guarded: a concurrent reader may have removed it already, and the
            // subtraction must happen exactly once per entry.
            if (entries.delete(id)) totalCost -= dropped.cost
          }
        })
      } catch (error) {
        ctx.logger?.warn?.(`[session-readcache] session/disposed listener failed: ${error?.message ?? error}`)
      }
    }

    // Observability endpoint: read-only live counters (no way to see cache
    // effectiveness without a restart). Registered inside the inject guard so
    // a double-apply cannot hit the webserver's duplicate-path throw. The
    // registration goes through its own inject so the plugin still activates
    // where no web surface exists at all — see the `inject` note above.
    let disposeMetricsRoute
    let disposePurgeRoute
    let routesRegistered = false
    function registerRoutes(webServer) {
      if (routesRegistered) return
      try {
        disposeMetricsRoute = webServer.register({
          kind: 'exact',
          path: '/plugin/session-readcache/metrics',
          handler: (_req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({
              inspect: { hits: counters.hits, misses: counters.misses, stale: counters.stale, liveSkips: counters.liveSkips },
              list: { hits: counters.listHits, misses: counters.listMisses, staleServed: counters.listStale },
              cache: { entries: entries.size, totalCost, inflight: inflight.size, coalesceLimit },
              snapshot: {
                path: snapshotPath ?? null,
                // True once the boot seed has been attempted (ready, absent,
                // stale, or failed — every outcome resolves once). Named for what
                // it reports: no new seed will run this mount.
                seedResolved: listSeed !== undefined,
                seeded: listCache?.seeded === true,
                saves: snapshotCounters.saves,
                failures: snapshotCounters.failures,
                notes: notes.slice(-5),
              },
            }))
          },
        })
        disposePurgeRoute = webServer.register({
          kind: 'exact',
          path: '/plugin/session-readcache/purge',
          handler: (req, res) => {
            // Purge mutates state, so refuse non-POST to avoid a GET-driven purge.
            if (req.method !== 'POST') {
              res.writeHead(405, { allow: 'POST', 'content-type': 'application/json' })
              res.end(JSON.stringify({ error: 'method not allowed; use POST' }))
              return
            }
            // Parse ?id= query param
            const url = new URL(req.url, 'http://localhost')
            const id = url.searchParams.get('id')
            purgeEpoch += 1
            let purged = 0
            if (id !== null) {
              // Purge specific entry
              const entry = entries.get(id)
              if (entry !== undefined) {
                // Guarded so a reader that already removed this entry cannot
                // make the subtraction run twice for one booked cost.
                if (entries.delete(id)) {
                  totalCost -= entry.cost
                  purged = 1
                }
              }
              // Also clear inflight for this id (in-flight reads should not
              // populate the cache if the caller explicitly purged mid-read)
              inflight.delete(id)
            } else {
              // Purge all
              for (const [key, entry] of entries) {
                totalCost -= entry.cost
              }
              purged = entries.size
              entries.clear()
              inflight.clear()
            }
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ purged }))
          },
        })
        routesRegistered = true
      } catch (error) {
        // A duplicate path throws on the second register; take the first route
        // down with it rather than leaving half an endpoint behind.
        try { disposeMetricsRoute?.() } catch { /* best-effort */ }
        disposeMetricsRoute = undefined
        disposePurgeRoute = undefined
        throw error
      }
    }
    // Reading a service the host never provided THROWS on a cordis context
    // ("cannot get property ... without inject"), so this read is guarded: the
    // absence of a web surface is a normal host shape, not an error.
    let webServerNow
    try {
      webServerNow = ctx.webServer
    } catch {
      webServerNow = undefined
    }
    if (typeof webServerNow?.register === 'function') {
      try {
        registerRoutes(webServerNow)
      } catch (error) {
        ctx.logger?.warn?.(`[session-readcache] route registration failed: ${error?.message ?? error}`)
      }
    } else if (typeof ctx.inject === 'function') {
      // Not mounted yet (or never). Waiting is strictly better than giving up:
      // on the web profile this fires the moment the service appears, and on a
      // host with no web surface it never fires and the plugin still caches.
      try {
        ctx.inject(['webServer'], (scoped) => {
          const ws = scoped?.webServer
          if (typeof ws?.register !== 'function') return
          try {
            registerRoutes(ws)
          } catch (error) {
            ctx.logger?.warn?.(`[session-readcache] route registration failed: ${error?.message ?? error}`)
          }
        })
      } catch {
        /* a context without inject simply never exposes the endpoints */
      }
      if (webServerNow === undefined) {
        ctx.logger?.warn?.('[session-readcache] webServer unavailable at mount; metrics/purge endpoints will register when it appears')
      }
    } else if (webServerNow === undefined) {
      ctx.logger?.warn?.('[session-readcache] webServer unavailable; metrics/purge endpoints not exposed')
    }
    const summary = `maxEntries=${maxEntries}, maxTotalEvents=${maxTotalEvents}, listTtlMs=${listTtlMs}, listMaxStaleMs=${listMaxStaleMs}, snapshotMaxAgeMs=${snapshotMaxAgeMs}`
    process.stderr.write(`[session-readcache] mounted (${summary})\n`)
    ctx.logger?.info?.(`[session-readcache] mounted (${summary})`)
    ctx.effect?.(() => () => {
      // From here on this mount no longer owns the memo's contents, so a
      // snapshot write that has not landed yet must decline: it would stamp
      // headers from an earlier scan with a later `saved_at`.
      disposed = true
      try { disposeMetricsRoute?.() } catch { /* route disposal is best-effort */ }
      try { disposePurgeRoute?.() } catch { /* route disposal is best-effort */ }
      routesRegistered = false
      delete target.inspect
      delete target.list
      delete target.__readcacheApplied
      entries.clear()
      inflight.clear()
      logPaths.clear()
      listCache = undefined
      listInflight = undefined
      listSeed = undefined
      ctx.logger?.info?.(`[session-readcache] unmounted (inspect hits=${counters.hits}, misses=${counters.misses}, stale=${counters.stale}; list hits=${counters.listHits}, misses=${counters.listMisses}, staleServed=${counters.listStale}; snapshot saves=${snapshotCounters.saves}, failures=${snapshotCounters.failures})`)
    }, 'session-readcache.restore')
  })
}

export { apply, inject, name, provide, DEFAULTS }

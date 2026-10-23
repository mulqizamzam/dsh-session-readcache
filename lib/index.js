// dsh-session-readcache: advisory read cache for the host's SessionPersistence service.
// On host 0.2.0-rc.2 `inspect` is gone from the service, so this wraps `list`
// only (short-TTL memo with in-flight coalescing, stale-while-revalidate, and
// a persisted snapshot that seeds the first reply after a restart). Cold-only;
// every failure path delegates to the original method.
import { stat, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const name = 'session-readcache'
// Only services that every host context is guaranteed to provide may be declared
// here. A declared name with no implementation leaves the cordis fiber epoch
// INACTIVE, and the plugin body then never runs at all, silently, with no error
// (cordis Fiber._refresh/_setEpoch). That was measured: a real host context
// holding SessionStore + JsonlSessionPersistence but no web surface never
// executed apply(), so the wrapper never installed. webServer is therefore
// awaited through ctx.inject() below, which fires when the service appears and
// simply never fires on hosts that have none.
const inject = ['sessionPersistence', 'sessions']
const provide = []

const DEFAULTS = {
  listTtlMs: 5000,
  // A directory scan is measured in seconds: the real list() takes 12.9 s median
  // over 5,343 logs (measured 2026-10-21), so a strict TTL expires before any
  // caller can be served: the live counters still read 0 hits (as of the
  // 2026-10-08 baseline). Within this window an expired memo is handed back while
  // a refresh runs behind it, turning a seconds-long wait into a sub-millisecond
  // reply at a cost in staleness. 0 preserves the strict-TTL behaviour.
  listMaxStaleMs: 120_000,
  // Upper age of a persisted snapshot that may seed the memo at boot, so a
  // restart does not pay a full scan for its first reply. 0 disables seeding.
  // 24 h, not 10 min: the row is only rewritten after a scan, so the gap
  // between the last scan and a restart is usually longer than a short
  // window. Measured 2026-10-21 on the live host: the row was 56 min old at
  // boot, a 10 min window refused it, and the first reply paid the very scan
  // the seed exists to avoid. The row is a session list; it changes slowly.
  snapshotMaxAgeMs: 86_400_000,
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
    // The handle exists whenever `exec` is what threw, a corrupt or
    // non-SQLite file gets that far, and returning without closing it leaks an
    // fd per scan, since every completed scan writes a snapshot.
    try { db?.close() } catch { /* the handle is already unusable */ }
    return { error }
  }
}

/** True when `object` owns a key that can reach a prototype when copied. */
function hasForbiddenKey(object) {
  return FORBIDDEN_HEADER_KEYS.some((key) => Object.prototype.hasOwnProperty.call(object, key))
}

/**
 * True when `value` is an AbortSignal itself rather than the options bag that
 * carries one. Duck-typed because the wrapper sits below the host's types and
 * must recognise both argument shapes the service has used.
 */
function isAbortSignalLike(value) {
  return value !== null &&
    typeof value === 'object' &&
    typeof value.aborted === 'boolean' &&
    typeof value.addEventListener === 'function'
}

/**
 * Shape check shared by the persisted row and the live scan.
 *
 * A row is only served when every element is a session SNAPSHOT, the shape
 * `SessionPersistence.list` actually returns (`{header, revision, ...}`, per
 * packages/session/session-persistence), not a flat header. Both in-tree
 * callers read `snapshot.header.id` (session-query's listPersisted and ACP's
 * sessionList). Checking a top-level `id` instead made every real row fail
 * this predicate, so boot seeding refused the host's own snapshot: observed
 * live as `snapshot headers are not session headers; rescanning` with
 * saves=1, failures=1, and a memo that never seeded after restart.
 */
function snapshotsAreSound(snapshots) {
  if (!Array.isArray(snapshots)) return false
  return snapshots.every((snapshot) =>
    snapshot !== null &&
    typeof snapshot === 'object' &&
    snapshot.header !== null &&
    typeof snapshot.header === 'object' &&
    typeof snapshot.header.id === 'string' &&
    !hasForbiddenKey(snapshot) &&
    !hasForbiddenKey(snapshot.header))
}

/** Read the persisted list snapshot. Returns undefined on any failure. */
async function loadSnapshot(path) {
  try {
    // A path that was never written, no file, or not even a directory yet, is
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
 * relies on, that `saved_at` describes the age of the rows next to it. Only
 * unmount has this race, because the async gap before the write is the
 * directory creation and database open, not the statement itself.
 */
async function saveSnapshot(path, headers, stillMounted) {
  try {
    if (!Array.isArray(headers)) return new Error('refusing to snapshot a non-array list result')
    // The serialization is O(the whole list): 2.9 ms for one list of 4,016
    // snapshots, measured 2026-10-20 on the corpus of that day, and it must not
    // run on the caller's response path. A macrotask boundary puts it AFTER the
    // reply that ended the scan; a microtask would not, because the caller's
    // own continuation is a microtask too and would still be behind it.
    await new Promise((resolve) => setImmediate(resolve))
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
  const listTtlMs = resolved.listTtlMs
  const listMaxStaleMs = resolved.listMaxStaleMs
  const snapshotMaxAgeMs = resolved.snapshotMaxAgeMs
  // disposeRowsRemoved counts the disposes that actually took a row OUT of
  // the memo, which is not the same thing as the number of disposes seen:
  // disposedInvalidations counts the events, this one counts the effect.
  const counters = { listHits: 0, listMisses: 0, listStale: 0, disposedInvalidations: 0, disposeRowsRemoved: 0, purgeDrops: 0 }
  const snapshotCounters = { saves: 0, failures: 0 }
  const notes = []
  function note(text) {
    notes.push(text)
    if (notes.length > NOTES_LIMIT) notes.splice(0, notes.length - NOTES_LIMIT)
  }

  ctx.inject(['sessionPersistence', 'sessions'], ({ sessionPersistence: target, sessions }) => {
    if (target.__readcacheApplied) return
    // Host 0.2.0-rc.2 removed `inspect` from SessionPersistence: session
    // reads now flow through sessionQuery.observeSession, whose cold reads
    // the host already caches itself (bounded, stat-revision-keyed) and whose
    // observations are disposable leases a second cache must not share. The
    // one read path the host performs uncached on every call is `list`, the
    // directory scan behind session.list, so that is all this wraps now.
    // A host without the method mounts inert-but-observable instead of dying
    // before its banner, which is how this plugin used to fail on this host
    // with no log line at all.
    const originalList = typeof target.list === 'function' ? target.list.bind(target) : undefined
    const mode = originalList === undefined ? 'inert' : 'list-memo'
    // Epochs guard the memo from installing a scan that a purge invalidated
    // while it ran: read before the await, checked after it.
    let purgeEpoch = 0

    let listCache
    let listInflight
    // Set when the memo is known to be out of date (a session was disposed).
    // A dirty memo is never handed out as a FRESH hit; it is served from
    // memory and the refresh behind it reconciles it with the host's truth.
    let listDirty = false
    // Flips the first time this mount is unwrapped. A snapshot write that is
    // already scheduled reads it just before writing: disposing mid-scan stops
    // an orphan write from stamping headers from an earlier scan with a later
    // `saved_at`, which would otherwise pass `snapshotMaxAgeMs` for content it
    // does not describe.
    let disposed = false
    // Boot seeding, resolved once: the last completed scan persisted to
    // SQLite so a restart answers immediately while a real scan refreshes
    // behind it. Only the first scan funds it (memoized on this promise), and
    // every outcome, ready, absent, stale, failed, resolves exactly once.
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
          // session snapshot: any element that is not (a number, null, an
          // object without a header, a header without a string id, an object
          // carrying a prototype-reaching key) would be handed to callers as a
          // session row, because the memo hands its contents out as-is and the
          // host later looks each one up by id. One bad element means the whole
          // row is suspect, so all of them must pass rather than the array
          // being trimmed to fit.
          if (!snapshotsAreSound(headers)) {
            snapshotCounters.failures += 1
            note('snapshot row is not a list of session snapshots; rescanning')
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
    // Copy on the way out, and rebuild each snapshot key by key so an own
    // `__proto__` (or the other two prototype-reaching names) can never ride
    // along into a caller's object, on the snapshot AND inside its header,
    // which is where the id the host looks sessions up by lives. Snapshots
    // are flat scalar records under one nested header, so a one-level rebuild
    // is a complete copy; the seed path already refuses a row containing those
    // keys, and this covers a live scan as well. Non-object elements pass
    // through untouched: the memo only ever holds host-produced arrays or a
    // row that passed the soundness check.
    function copyHeader(header) {
      if (header === null || typeof header !== 'object') return header
      const out = {}
      for (const key of Object.keys(header)) {
        if (FORBIDDEN_HEADER_KEYS.includes(key)) continue
        out[key] = header[key]
      }
      return out
    }
    function copy(value) {
      return value.map((snapshot) => {
        if (snapshot === null || typeof snapshot !== 'object') return snapshot
        const out = {}
        for (const key of Object.keys(snapshot)) {
          if (FORBIDDEN_HEADER_KEYS.includes(key)) continue
          out[key] = key === 'header' ? copyHeader(snapshot.header) : snapshot[key]
        }
        return out
      })
    }
    // The memo itself, without counting: the copy-out and the seed check read
    // out of the memo, and those must not look like a caller of list().
    function listMemo(options) {
      if (listCache !== undefined && !listDirty && clock.monotonic() - listCache.at < listTtlMs) return Promise.resolve(listCache.value)
      if (listInflight !== undefined) return listInflight
      // The seed is awaited INSIDE the in-flight slot so a boot-time caller and
      // every caller racing it share one wait instead of one scan each, and so
      // the slot is released no matter which branch answers.
      const pending = (async () => {
        await ensureSeeded()
        if (listCache !== undefined && !listDirty && clock.monotonic() - listCache.at < listTtlMs) return listCache.value
        // Counted here, not in list(): a scan is a scan whoever started it, and
        // the path lookup below starts them too.
        counters.listMisses += 1
        // Read before the await: a purge that lands during the scan must stop
        // the scan from installing (and snapshotting) after it.
        const purge = purgeEpoch
        // The starting caller's options ride along with the shared scan, so a
        // `{signal}` caller's cancellation still governs the I/O it pays for;
        // callers that join this slot share that scan (and its fate).
        const value = await originalList(options)
        if (purge !== purgeEpoch) return value
        listCache = { value, at: clock.monotonic() }
        listDirty = false
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
    function list(options) {
      // The host's first argument is an OPTIONS BAG whose only field is an
      // optional signal (`SessionPersistenceListOptions = {signal?}`), never
      // the signal itself: both in-tree callers pass `{signal}` (session-
      // query's listPersisted, ACP's sessionList). Reading the argument as if
      // it WERE a signal treated every such caller as "cancellable, bypass the
      // memo", the live host recorded 15 misses and 0 hits, i.e. the memo
      // never once served the GUI. Only a caller that is ALREADY cancelled
      // bypasses now: the host rejects it as the first statement of its own
      // loop, so no directory is walked and nothing is counted. A live signal
      // is served from memory because cancelling a scan does not make a
      // memoized reply stale.
      //
      // A host that ever passes the signal directly (older builds) is still
      // recognised, so the abort invariant survives both argument shapes.
      const signal = isAbortSignalLike(options) ? options : options?.signal
      if (signal !== undefined && signal.aborted) {
        // Forward the caller's own argument untouched, options bag or signal.
        return originalList(options)
      }
      if (listCache !== undefined) {
        const age = clock.monotonic() - listCache.at
        if (!listDirty && age < listTtlMs) {
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
      return listMemo(options).then(copy)
    }
    if (originalList !== undefined) {
      Object.defineProperty(target, 'list', { value: list, configurable: true, writable: true })
    }
    Object.defineProperty(target, '__readcacheApplied', { value: true, configurable: true })

    // The id of a memo row. The host's list() resolves to session SNAPSHOTS
    // (`{header, revision, ...}`), so the id lives in `header.id`; a flat `id`
    // is accepted as a fallback for a row that carries no header object.
    const rowId = (row) => {
      if (row === null || typeof row !== 'object') return undefined
      const header = row.header
      if (header !== null && typeof header === 'object') {
        return typeof header.id === 'string' ? header.id : undefined
      }
      return typeof row.id === 'string' ? row.id : undefined
    }
    // A row the host's list() named because the session has a MATERIALIZED
    // artifact on disk carries sizeBytes; a row it named because the session
    // is LIVE but not written yet does not. sizeBytes is optional in the
    // host's SessionPersistenceSnapshot contract, so its absence only ever
    // makes the plugin ask the host, the safe direction, while its presence
    // is the host's own statement that an artifact exists.
    const isMaterialized = (row) => typeof row?.sizeBytes === 'number'
    // Settle ONE disposed session's row against the host's own truth.
    // `target.stat(id)` is the host's own API on the service this plugin wraps,
    // and the SHAPE of its answer is the information: `undefined` means the
    // session has no durable artifact, so the host will not list it and the
    // row goes; a snapshot means the artifact exists, the host still lists
    // that session, and the row stays. A snapshot without sizeBytes means the
    // backend does not report a size, which is not proof of absence, so the
    // row stays there too. Absence must be proven before a row goes.
    function invalidateDisposedRow(id) {
      if (listCache === undefined || !Array.isArray(listCache.value)) return
      const row = listCache.value.find((candidate) => rowId(candidate) === id)
      if (row === undefined) return
      // Only a row the host's list() named because the session was LIVE but
      // not written yet can go stale on a dispose: the artifact of a
      // materialized session outlives the session, a dispose detaches the
      // session, it does not delete the log, so the host still lists it and
      // the row is correct. Asking about such a row is also the expensive
      // question: measured on this host's 5,343-log corpus, a stat() on a
      // pre-v4 log hashes the whole corpus (historicalCorpusRevision) and
      // costs a median of 1.96 s, while the answer for a materialized
      // session is always "a snapshot exists", i.e. the row stays. A
      // live-but-unwritten row is the cheap question (a findLog walk, no
      // corpus hash) and the only one whose answer can be undefined.
      if (isMaterialized(row)) return
      // No stat method on this host build: absence is not proven, so the row
      // stays and the memo stays dirty.
      if (typeof target.stat !== 'function') return
      let pending
      try {
        // `source: 'disk'` asks the host for the DURABLE artifact, not for
        // "does this process still track it". The tracker keeps a session that
        // was created but never written, and that entry is released only when
        // the write handle closes, so the tracked answer would say "present"
        // for a session the host is about to stop listing. A host that does
        // not know the option ignores it and answers from the tracker, which
        // is the older, conservative answer: the row stays.
        pending = target.stat(id, { source: 'disk' })
      } catch (error) {
        note(`dispose: stat failed for ${id}: ${error?.message ?? error}`)
        return
      }
      Promise.resolve(pending).then((snapshot) => {
        // A snapshot means the artifact is still on disk, so the host still
        // lists this session: the row is correct and stays.
        if (snapshot !== undefined) return
        if (listCache === undefined || !Array.isArray(listCache.value)) return
        const value = listCache.value
        const filtered = value.filter((row) => rowId(row) !== id)
        if (filtered.length === value.length) return
        // Only the array changes. `at` and `seeded` are carried over, so the
        // memo's age and its seeded marker still describe what it holds, and
        // the memo stays dirty: the next caller is served from memory while a
        // refresh behind it reconciles the rest.
        listCache = { ...listCache, value: filtered }
        listDirty = true
        // The row is gone, and that is the only event this counter counts:
        // a dispose whose stat kept the row does not move it.
        counters.disposeRowsRemoved += 1
      }, (error) => {
        // The stat failed, so absence is NOT proven: the row stays and the
        // failure is recorded.
        note(`dispose: stat failed for ${id}: ${error?.message ?? error}`)
      }).catch(() => {
        // Advisory only: a failure inside the handler must not surface as an
        // unhandled rejection.
        note(`dispose: stat failed for ${id}: the answer could not be applied`)
      })
    }
    // A session that leaves the store must stop being served from cache before
    // the host finishes draining it. Registered as its own inject rather than
    // a synchronous read so a host without the web surface still gets the
    // lifecycle listener; the listener itself is tiny and idempotent.
    //
    // THE RULE. A dispose is a ONE-ROW event and the memo is a WHOLE-LIST
    // memo, so the row for the disposed session is settled by asking the host
    // about that one session instead of by guessing: `target.stat(id)` is the
    // host's own API, it resolves to a snapshot when the session still has an
    // artifact on disk (the host's list() is disk-based, so a detached session
    // that was materialized is STILL listed) and to undefined when it has
    // none (the host would not list it). Therefore:
    //
    //   - stat resolves a snapshot -> the host still lists it -> KEEP the row
    //   - stat resolves undefined  -> the host would not list it -> REMOVE it
    //   - stat rejects             -> absence is not proven -> KEEP the row
    //   - no stat method           -> absence is not proven -> KEEP the row
    //
    // WHICH ROWS ARE ASKED ABOUT. Only the rows that can actually go stale: a
    // row the host's list() named because the session was LIVE but not written
    // yet. A row it named because the session has an artifact on disk carries
    // sizeBytes, and that artifact outlives the session, a dispose detaches
    // the session, it does not delete the log, so the host still lists it and
    // the row is correct. Asking anyway is also the expensive question: on
    // this host's 5,343-log corpus a stat() on a pre-v4 log hashes the whole
    // corpus (historicalCorpusRevision) and costs a median of 1.96 s, while
    // the answer for a materialized session is always "a snapshot exists",
    // i.e. the row stays. A live-but-unwritten row is the cheap question (a
    // findLog walk, no corpus hash) and the only one whose answer can be
    // undefined. The one case this gives up is a materialized session whose
    // artifact is deleted OUTSIDE the dispose path (the host's own delete()
    // API, or a file removed by hand): its row then stays until the next
    // refresh, which is the bound the plugin had before this rule existed.
    //
    // WHY THE MEMO IS NOT DROPPED. Throwing the whole memo away turns a
    // one-row change into a full directory scan for the next caller, who
    // would wait for it: measured 12.9 s median over 5,343 logs on this host
    // (2026-10-21). The rescan also reproduced the memo's own contents. So
    // the memo is marked dirty instead: the next caller is still answered
    // from memory, and the refresh behind it reconciles the memo with the
    // host's truth. Only the array changes when a row is removed; `at` and
    // `seeded` stay, and the memo stays dirty so that refresh still happens.
    if (typeof ctx.on === 'function') {
      try {
        ctx.on('session/disposed', (session) => {
          try {
            const id = session?.id
            if (typeof id !== 'string') return
            listDirty = true
            if (listCache !== undefined) {
              counters.disposedInvalidations += 1
            }
            invalidateDisposedRow(id)
          } catch (error) {
            // The listener must never throw and must never reject.
            ctx.logger?.warn?.(`[session-readcache] session/disposed handler failed: ${error?.message ?? error}`)
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
    // where no web surface exists at all, see the `inject` note above.
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
              mode,
              list: { hits: counters.listHits, misses: counters.listMisses, staleServed: counters.listStale },
              lifecycle: {
                disposedInvalidations: counters.disposedInvalidations,
                // The disposes that actually took a row out of the memo. Zero
                // here with a non-zero disposedInvalidations means every
                // disposed session still has an artifact on disk, so the host
                // still lists it and its row was correct.
                disposeRowsRemoved: counters.disposeRowsRemoved,
                purgeDrops: counters.purgeDrops,
              },
              memo: {
                warm: listCache !== undefined,
                ageMs: listCache === undefined ? null : Math.round(clock.monotonic() - listCache.at),
                inflight: listInflight !== undefined,
              },
              config: { listTtlMs, listMaxStaleMs, snapshotMaxAgeMs },
              snapshot: {
                path: snapshotPath ?? null,
                // True once the boot seed has been attempted (ready, absent,
                // stale, or failed, every outcome resolves once). Named for what
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
            // One memo, one purge: an in-flight scan that lands after the
            // purge must not install (listMemo re-reads purgeEpoch).
            purgeEpoch += 1
            const warm = listCache !== undefined
            listCache = undefined
            listInflight = undefined
            if (warm) counters.purgeDrops += 1
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ purged: warm ? 1 : 0 }))
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
    const summary = `mode=${mode}, listTtlMs=${listTtlMs}, listMaxStaleMs=${listMaxStaleMs}, snapshotMaxAgeMs=${snapshotMaxAgeMs}, snapshot=${snapshotPath === undefined ? 'off' : 'on'}`
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
      delete target.list
      delete target.__readcacheApplied
      listCache = undefined
      listInflight = undefined
      listSeed = undefined
      ctx.logger?.info?.(`[session-readcache] unmounted (list hits=${counters.listHits}, misses=${counters.listMisses}, staleServed=${counters.listStale}; disposedInvalidations=${counters.disposedInvalidations}, disposeRowsRemoved=${counters.disposeRowsRemoved}, purgeDrops=${counters.purgeDrops}; snapshot saves=${snapshotCounters.saves}, failures=${snapshotCounters.failures})`)
    }, 'session-readcache.restore')
  })
}

export { apply, inject, name, provide, DEFAULTS }

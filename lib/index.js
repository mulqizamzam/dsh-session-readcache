// dsh-session-readcache: advisory read cache for the host's SessionPersistence service.
// Wraps the shared `sessionPersistence` instance's `inspect` (LRU beyond the host's
// built-in capacity-5 preparation cache, stat-validated) and `list` (short-TTL memo with
// in-flight coalescing). Cold-only; every failure path delegates to the original method.
import { stat, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const name = 'session-readcache'
const inject = ['sessionPersistence', 'sessions', 'webServer']
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

function positiveInt(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function nonNegativeInt(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback
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

// Loaded lazily: a native-addon load failure must not take the plugin down,
// so every path here degrades to "no snapshot" rather than throwing.
let nativeModule
async function openDatabase(path) {
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
    await mkdir(dirname(path), { recursive: true })
    db = new nativeModule(path)
    db.exec(`CREATE TABLE IF NOT EXISTS readcache_list_snapshot (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      saved_at INTEGER NOT NULL,
      headers TEXT NOT NULL
    )`)
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

/** Read the persisted list snapshot. Returns undefined on any failure. */
async function loadSnapshot(path) {
  try {
    const { db, error } = await openDatabase(path)
    if (db === undefined) return { error }
    try {
      const row = db.prepare('SELECT saved_at, headers FROM readcache_list_snapshot WHERE id = 1').get()
      if (row === undefined) return {}
      return { savedAt: row.saved_at, headers: JSON.parse(row.headers) }
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
    const { db, error } = await openDatabase(path)
    if (db === undefined) return error
    try {
      if (typeof stillMounted === 'function' && !stillMounted()) {
        return new Error('unmounted before the snapshot write landed')
      }
      db.prepare('INSERT OR REPLACE INTO readcache_list_snapshot (id, saved_at, headers) VALUES (1, ?, ?)')
        .run(Date.now(), JSON.stringify(headers))
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
  const maxEntries = positiveInt(config.maxEntries, DEFAULTS.maxEntries)
  const maxTotalEvents = positiveInt(config.maxTotalEvents, DEFAULTS.maxTotalEvents)
  const listTtlMs = nonNegativeInt(config.listTtlMs, DEFAULTS.listTtlMs)
  const listMaxStaleMs = nonNegativeInt(config.listMaxStaleMs, DEFAULTS.listMaxStaleMs)
  const snapshotMaxAgeMs = nonNegativeInt(config.snapshotMaxAgeMs, DEFAULTS.snapshotMaxAgeMs)
  const counters = { hits: 0, misses: 0, stale: 0, liveSkips: 0, listHits: 0, listMisses: 0, listStale: 0 }
  const notes = []

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
      const hit = entries.get(id)
      if (hit !== undefined) {
        const revision = await revisionOf(hit.path)
        // The stat yields the event loop, so an abort landing during it has to
        // be noticed here: this branch is the one return that never delegates
        // to the host's check. A signalled read is never coalesced, so the
        // caller waiting is its own and nobody else rejects for it.
        signal?.throwIfAborted()
        if (revision !== null && revision === hit.revision && sessions.get(id) === undefined) {
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
        // test above also fails on liveness alone, and counting that as `stale`
        // would report a stat mismatch for a file that was never touched —
        // attaching a session that was cached cold is the documented normal
        // flow, not a corruption signal. The miss path below books that
        // transition under liveSkips, where it belongs.
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
            notes.push(`snapshot load failed: ${error?.message ?? error}`)
            return
          }
          if (savedAt === undefined || !Array.isArray(headers)) return
          // Shape before trust. `Array.isArray` proves only that the file held a
          // JSON array: any element that is not a header (a number, null, an
          // object without an id) would be served as a session row, because the
          // memo hands its contents out as-is and the host later looks each one
          // up by id. One bad element means the whole row is suspect, so all of
          // them must pass rather than the array being trimmed to fit.
          const malformed = headers.find((header) =>
            header === null || typeof header !== 'object' || typeof header.id !== 'string')
          if (malformed !== undefined) {
            notes.push('snapshot headers are not session headers; rescanning')
            return
          }
          const age = Date.now() - savedAt
          if (age >= snapshotMaxAgeMs) {
            notes.push(`snapshot too old (${Math.round(age / 1000)}s); rescanning`)
            return
          }
          // Stamped at boot, not at the snapshot's own age: the seed exists to
          // answer the FIRST reply, and reusing `savedAt` would place a
          // snapshot minutes old far outside `listTtlMs + listMaxStaleMs`, so it
          // would be discarded instead of served. The honest consequence is that
          // `snapshotMaxAgeMs` gates BOOT seeding while the stale window bounds
          // staleness from then on, making the oldest servable reply
          // `snapshotMaxAgeMs + listTtlMs + listMaxStaleMs` old. README says so.
          listCache = { value: headers, at: Date.now(), seeded: true }
        })()
      }
      await listSeed
    }
    function copy(value) {
      return value.map((header) => ({ ...header }))
    }
    // The memo itself, without counting: `inspect` reads a header out of it to
    // resolve a log path, and that must not look like a caller of list().
    function listMemo() {
      if (listCache !== undefined && Date.now() - listCache.at < listTtlMs) return Promise.resolve(listCache.value)
      if (listInflight !== undefined) return listInflight
      // The seed is awaited INSIDE the in-flight slot so a boot-time caller and
      // every caller racing it share one wait instead of one scan each, and so
      // the slot is released no matter which branch answers.
      const pending = (async () => {
        await ensureSeeded()
        if (listCache !== undefined && Date.now() - listCache.at < listTtlMs) return listCache.value
        // Counted here, not in list(): a scan is a scan whoever started it, and
        // the path lookup below starts them too.
        counters.listMisses += 1
        const value = await originalList()
        listCache = { value, at: Date.now() }
        if (snapshotPath !== undefined) {
          // Off the response path: the caller already has its headers, and a
          // snapshot write must never delay or fail a list reply. The predicate
          // reads the flag rather than a captured token: the flag flips as soon
          // as this mount is disposed, even while the scan above is still
          // running, so a write scheduled after that scan lands only if the
          // mount that scheduled it is still the one that owns the memo.
          saveSnapshot(snapshotPath, value, () => !disposed).then((error) => {
            if (error !== undefined) notes.push(`snapshot save failed: ${error?.message ?? error}`)
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
        const age = Date.now() - listCache.at
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
    // Observability endpoint: read-only live counters (no way to see cache
    // effectiveness without a restart). Registered inside the inject guard so
    // a double-apply cannot hit the webserver's duplicate-path throw.
    let disposeMetricsRoute
    let disposePurgeRoute
    if (typeof ctx.webServer?.register === 'function') {
      try {
        disposeMetricsRoute = ctx.webServer.register({
          kind: 'exact',
          path: '/plugin/session-readcache/metrics',
          handler: (_req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({
              inspect: { hits: counters.hits, misses: counters.misses, stale: counters.stale, liveSkips: counters.liveSkips },
              list: { hits: counters.listHits, misses: counters.listMisses, staleServed: counters.listStale },
              cache: { entries: entries.size, totalCost, inflight: inflight.size },
              snapshot: {
                path: snapshotPath ?? null,
                // True once the boot seed has been attempted (ready, absent,
                // stale, or failed — every outcome resolves once). Named for what
                // it reports: no new seed will run this mount.
                seedResolved: listSeed !== undefined,
                seeded: listCache?.seeded === true,
                notes: notes.slice(-5),
              },
            }))
          },
        })
        disposePurgeRoute = ctx.webServer.register({
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
                entries.delete(id)
                totalCost -= entry.cost
                purged = 1
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
      } catch (error) {
        ctx.logger?.warn?.(`[session-readcache] route registration failed: ${error?.message ?? error}`)
      }
    } else if (ctx.webServer === undefined) {
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
      delete target.inspect
      delete target.list
      delete target.__readcacheApplied
      entries.clear()
      inflight.clear()
      logPaths.clear()
      listCache = undefined
      listInflight = undefined
      listSeed = undefined
      ctx.logger?.info?.(`[session-readcache] unmounted (inspect hits=${counters.hits}, misses=${counters.misses}, stale=${counters.stale}; list hits=${counters.listHits}, misses=${counters.listMisses}, staleServed=${counters.listStale})`)
    }, 'session-readcache.restore')
  })
}

export { apply, inject, name, provide, DEFAULTS }

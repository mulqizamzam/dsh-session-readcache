# dsh-session-readcache

Advisory read cache that speeds up **opening** chat sessions in the DSH Web GUI, without touching host code.

## Why it exists

Opening a **cold** (detached) session in the web GUI costs two uncached host operations per RPC:

1. `persistence.inspect(id)` — the host already caches these, but only **5** at a time (`DEFAULT_PREPARED_SESSION_CACHE_SIZE = 5`). Cycling through more than 5 cold sessions, or the first open after boot, pays a full read + zstd-decompress + `JSON.parse` of the whole `session.jsonl.zstd`. Measured: ~742 ms for a 12.3 MB / 45,500-event log.
2. `persistence.list()` — **no cache at all** in the host. Every cold open calls it to resolve the session's stored identity, scanning every project/session directory (3,847 logs / 1.6 GB here) each time.

This plugin wraps the shared `sessionPersistence` instance with:

- a **larger `inspect` LRU** (default 24 entries, ~250k-event total budget) that reuses the parsed view when the underlying file is unchanged. An entry is stamped with the revision taken **before** its read and validated with one `stat` per hit (`dev:ino:size:mtimeNs:ctimeNs`), so an append or rewrite is never certified by a stat taken after the content was parsed, and any append/rewrite forces a clean re-read.
- a **short-TTL `list` memo** (default 750 ms) with in-flight coalescing, so a burst of cold opens shares one directory scan.
- a **stale window** (default 30 s) for that memo: past the TTL but inside the window, the last scan is returned immediately while a refresh runs behind it. Without it the memo can never serve anything — see below.
- a **SQLite snapshot** of the last completed scan, so a restart does not pay a full scan for its first reply.

Result: repeat opens of the same session go from ~742 ms → ~8 ms (integration test, real log).

## Why the TTL alone never fires

A real `list()` scan costs **seconds**, not milliseconds: it walks every project and session directory, checks for an opposite-encoding artifact, and decodes one zstd header frame per log.

What was measured on this host, about 3,850 session logs (~1.7 GB, growing as new sessions are created):

| measurement | result |
| --- | --- |
| live `session.list` RPC (what a user waits) | **9.0–10.2 s** |
| header scan alone, warm page cache, serial | **2.7–3.0 s** |
| the same scan with the host's zstd helpers, cold | 9.8 s |
| that scan rewritten 32-way parallel | 1.4 s |

A strict header-scan memo alone had zero hits in production (`hits: 0` over 184 misses): the TTL expired before the caller that funded each scan was even back. The fix below adds a stale window so a call is served from the last scan while a refresh runs behind it.

**Correction to the earlier claim in this section:** an earlier version of this README said no header carries `sessionListMetadata` and every RPC re-decodes all logs. That was the wrong mechanism. Cold projections do not come from the header at all: `listProjectionsFor` (`api-proxy.ts:798-808`) reads the cold column from `sessionProjectionCache.cachedSnapshot()` (`session-projection-cache/src/index.ts:119`), and that cache is populated (verified at `storages/session_projcache.json`: 4,318 rows, all `ver: 1`, 4,275 `blank=false` vs 43 `blank=true`). Those rows let `summarizeCold` (`api-proxy.ts:553-555`) skip the probe, and any log over `DEFAULT_COLD_BLANK_PROBE_MAX_BYTES` (1,024 B, `api-proxy.ts:123`) is refused the probe before `readFrom` runs — independent check of the corpus: only 39 of ~3,860 logs are at or under 1,024 B. So the `readFrom(id, 0)` path is practically unreachable here; the remaining per-RPC cost is the header scan plus the per-session summarize loop, which is exactly what this plugin's memo + snapshot covers. The full correction and the revised host-side proposal live in `docs/HOST-TICKET-sessionListMetadata.md`.

So a strict TTL can never fire: with a 750 ms TTL the entry expires before the caller that triggered it is even back, and the live counters read exactly that:

```json
"list": { "hits": 0, "misses": 184, "staleServed": 0 }
```

Each stale-while-revalidate window turns a multi-second reply into a sub-millisecond one, at the cost of returning the previous scan's headers for at most `listMaxStaleMs`. Past that window the caller waits for a real scan again.

The snapshot covers the other half: the first reply after a restart. It is written off the response path and only seeds the memo when it is younger than `snapshotMaxAgeMs`.

**How old a reply can actually be.** After a real scan, one stale window is the whole bound: at most `listMaxStaleMs` old. After a boot seed the bound is `snapshotMaxAgeMs + listTtlMs + listMaxStaleMs`, because the seed is stamped at boot (that is what lets a snapshot minutes old answer the first reply at all) and then follows the same TTL and stale window as any other memo. With the shipped defaults that is 10 min + 750 ms + 30 s ≈ **10 min 31 s**. Lower `snapshotMaxAgeMs` if a boot must not answer from older data than that.

## Safety

- **Cold-only.** A session that is currently attached (`ctx.sessions.get(id) !== undefined`) is never cached — its events array is live and growing. Every cached path re-checks liveness before returning.
- **Cancellation-faithful.** The host rejects an aborted caller as the first statement of every `inspect` call, so a cache hit must not be an exception: the hit branch re-checks the signal on entry and again after its `stat` (which yields the event loop). A signalled read is never coalesced, so a rejected caller rejects only itself.
- **Advisory.** The cache is bookkeeping, not correctness. Any error in the cache layer (stat, locate, eviction) falls through to the original host method. If the plugin were removed entirely, behavior reverts to the host's own cache.
- **Non-committing.** It only wraps `inspect`/`list` (documented read methods); writes, `load`/`prepare`, and repairs are untouched.
- **Coexisting headers.** `list` results are shallow-copied per caller, so a consumer mutating a returned header cannot poison the cache or another caller.
- **Reversible.** `dispose` (unmount / reload) removes the wrappers via `ctx.effect`. It does **not** re-assign the originals: they are bound once at mount and only ever used as call-throughs. Removal is sufficient for the shipped backends, whose `inspect`/`list` live on the class prototype, so the prototype method resurfaces once the wrapper's own property is deleted. A host object that defined them as own properties would come back without them.
- **No orphan snapshot writes.** A completed scan schedules its snapshot write off the response path, so unmount can land first. The write re-checks a per-mount `disposed` flag immediately before writing and declines if the mount is gone, reporting `snapshot save failed: unmounted before the snapshot write landed` in `snapshot.notes`. Without that check a late write stamps headers from an earlier scan with a newer `saved_at`, and the next mount's `snapshotMaxAgeMs` would accept content that does not match the age it claims.

## Install

```bash
dsh plugin --profile web add link:/home/administrator/agent-workspace/dsh-custom/plugins/dsh-session-readcache
```

If your `dsh` version registers the dependency but does not append the bundle automatically, add `"dsh-session-readcache"` to `dsh.profile.bundles` in `~/.dsh/profiles/web/package.json`. Restart the web server to activate (a running server keeps its already-resolved modules).

## Config

`cordis.patch.yml` inserts the row with these keys (all optional; defaults in `lib/index.js`):

| key | default | effect |
| --- | --- | --- |
| `enabled` | `true` | `false` neutralizes the plugin (no wrapping) without uninstalling |
| `maxEntries` | `24` | inspect-cache LRU size (host's own cache is 5) |
| `maxTotalEvents` | `250000` | total parsed-event budget across cached sessions |
| `listTtlMs` | `750` | fresh results are served as hits inside this window |
| `listMaxStaleMs` | `30000` | past the TTL but inside this window, the last scan is served while a refresh runs behind it |
| `snapshotMaxAgeMs` | `600000` | a persisted list snapshot may seed the memo at boot while younger than this |
| `snapshotPath` | _(derived)_ | explicit snapshot path; default is `<harness home>/plugins/session-readcache/list-snapshot.db` |

## SQLite dependency

The snapshot needs a store that survives restarts. `better-sqlite3` (pinned to your chosen fork commit, native module built from source in this plugin's own `node_modules`) holds exactly one row: the last completed `list()` result with its timestamp.

- Without it (missing, load failure, no writable home), the plugin still runs: TTL + stale window work in memory; only boot seeding is off, and the reason is reported in the metrics endpoint's `snapshot.notes`.
- Better or worse than a JSON file: SQLite turns the read-modify-write of the snapshot into one atomic `INSERT OR REPLACE`; a JSON file would need temp-write + fsync + rename to survive a kill mid-write. The price is a 29 MB native module tied to the Node ABI.

## Metrics

Live counters, read-only:

```bash
curl http://127.0.0.1:13080/plugin/session-readcache/metrics
```

```json
{
  "inspect": { "hits": 12, "misses": 5, "stale": 2, "liveSkips": 0 },
  "list": { "hits": 8, "misses": 3, "staleServed": 40 },
  "cache": { "entries": 4, "totalCost": 28473, "inflight": 0 },
  "snapshot": { "path": "...", "seedResolved": true, "seeded": true, "notes": [] }
}
```

- `inspect.hits/misses` — cache hit vs full disk read.
- `inspect.stale` — entries dropped because the file changed (stat mismatch).
- `inspect.liveSkips` — live sessions refused for caching (correctness guard).
- `list.hits/misses` — TTL reuse vs directory scan. A scan started to resolve a session's log path counts here too, so `misses` is the honest scan count rather than a count of `list()` callers.
- `list.staleServed` — replies served from the stale window, each of which also kicked one background refresh. `hits` staying near zero while this climbs is the expected healthy shape on a host where a scan costs seconds.
- `cache.entries` / `cache.totalCost` — current entries and parsed-event budget in use.
- `cache.inflight` — reads currently being folded.
- `snapshot.seedResolved` — true once the boot seed has been attempted in this mount (found, absent, stale, or failed — every outcome counts).
- `snapshot.seeded` — true only while the memo still holds headers that came from the snapshot; a later real scan replaces them and resets this.
- `snapshot.notes` — why snapshot persistence is not working, when it is not.

Counters reset on restart. The route is removed on plugin unmount. If `ctx.webServer` is unavailable, the plugin logs a warning and runs without the endpoint (advisory: boot never blocks).

## Purge

Explicit cache invalidation — purge one session entry or the entire cache:

```bash
# Purge one entry
curl -X POST 'http://127.0.0.1:13080/plugin/session-readcache/purge?id=s1'

# Purge all entries
curl -X POST 'http://127.0.0.1:13080/plugin/session-readcache/purge'
```

Response:
```json
{ "purged": 1 }
```

- `?id=<sessionId>` — removes that entry from cache and inflight; `purged: 1` if found, `0` if absent.
- No `id` — clears all entries and inflight; `purged: N` where N was the entry count.

After a purge, the next `inspect(id)` re-reads from disk. A purge does not touch the `list` memo (TTL-bound), and it deliberately keeps the resolved log-path memo, so a later read still skips the directory scan even though the parsed view is re-read. Purging an id that is not resident reports `purged: 0` but still advances the invalidation epoch, which stops a read already in flight for **any** id from installing.

## Tests

```bash
node tests/logic.mjs                        # 34 unit tests against a fake service
node tests/subagent-signal.mjs              # 8 tests on the inspect(id, signal) paths
tsx tests/realfile.mts                      # integration probe on the largest real session log
```

`subagent-signal.mjs` is the execution evidence for SECURITY-AUDIT.md §4: signalled
callers are never folded (each signal owns its cancellation), unsignalled callers
coalesce into one read, and an abort rejects only its own caller without poisoning
the cache. Its last two cases warm the cache first and then abort, which is the
combination the host contract covers and the one a cold-cache test cannot reach:
rejection is asserted for a signal already aborted on entry, and for one aborted
while the hit path is parked on its `stat`.

`realfile.mts` discovers the biggest `session.jsonl.zstd` at run time (the store rotates), decodes it with the real host frame decoder, and asserts: cached repeat does not re-read, a same-object frozen view is returned, and appending a valid frame invalidates the entry.

## Rebuilding the native module

`better-sqlite3` dipakai plugin ini sebagai store snapshot SQLite. Modulnya dikompilasi dari source, bukan diambil jadi satu file, jadi ia terikat pada ABI Node yang sedang berjalan. Yang ada di repo ini: `node_modules/better-sqlite3/build/Release/better_sqlite3.node` berukuran 2.252.424 byte, versi 12.4.1 dari `github:ZiuChen/better-sqlite3` yang terpin di `ea0d8c73615ce2b6133df67da10c7e6452115d73`.

### Kapan perlu rebuild

- Node host di-upgrade, sehingga ABI yang dipakai modul native tidak lagi cocok dengan hasil kompilasi sebelumnya.
- `node_modules` hilang atau ikut terhapus, jadi modul native tidak ada sama sekali sampai dibangun ulang.
- `node_modules/better-sqlite3/build/Release/better_sqlite3.node` tidak ditemukan, atau `require('better-sqlite3')` gagal dimuat.

Host proses `dsh web` memuat ESM sekali saja saat boot. Jadi perubahan pada `lib/index.js` tidak aktif sampai web server di-restart, dan restart itu dijalankan OWNER, bukan agen.

### Perintahnya

Host ini punya `$HOME` read-only untuk npm dan gyp, jadi dua cache harus diarahkan ke path writable di dalam project. Tanpa override, `npm i` dengan cache default gagal: `EROFS open '/home/administrator/.npm/_cacache/...'`. Dan `node-gyp` tanpa override juga gagal: `ENOENT: no such file or directory, mkdir '/home/administrator/.cache/node-gyp'`, lalu install di-rollback. Jadi dua baris ini wajib, tidak boleh salah satu saja:

```bash
cd /home/administrator/agent-workspace/dsh-custom/plugins/dsh-session-readcache
npm_config_devdir="$PWD/.npm-cache/node-gyp" npm rebuild better-sqlite3 --cache ./.npm-cache
```

Kalau yang perlu dibangun ulang adalah dependensi secara keseluruhan, pakai `npm install` dengan pasangan yang sama:

```bash
npm_config_devdir="$PWD/.npm-cache/node-gyp" npm install --cache ./.npm-cache
```

`--cache ./.npm-cache` memindahkan cache npm, dan `npm_config_devdir="$PWD/.npm-cache/node-gyp"` memindahkan cache `node-gyp` ke `.npm-cache/node-gyp`.

Toolchain yang dibutuhkan sudah ada di PATH pada host ini: `gcc`, `g++`, `make`, dan `python3`. Node host-nya v24.19.0.

### Verifikasi hasilnya

Pertama, cek file binary-nya ada:

```bash
ls -la node_modules/better-sqlite3/build/Release/*.node
```

Lalu load test sungguhan, bukan hanya cek file. Buka database di memori, nyalakan `journal_mode = WAL`, insert 1000 baris dalam satu transaksi, baca `sqlite_version()`, dan perhatikan baris `LOAD_TEST_OK` di akhir:

```bash
node -e '
const Database = require("better-sqlite3");
const db = new Database(":memory:");
db.pragma("journal_mode = WAL");
db.exec("CREATE TABLE t (v INTEGER)");
const insert = db.prepare("INSERT INTO t (v) VALUES (?)");
db.transaction(() => { for (let i = 0; i < 1000; i++) insert.run(i); })();
console.log("sqlite_version:", db.prepare("SELECT sqlite_version() AS v").get().v);
console.log("LOAD_TEST_OK");
'
```

Kalau `LOAD_TEST_OK` tidak muncul, modul yang dibangun belum benar dan jangan dipakai.

### Kenapa cache disimpan di dalam project

Dua cache itu disimpan supaya rebuild berikutnya tetap jalan saat `$HOME` read-only, tanpa jaringan tambahan di luar yang sudah ada. Isi `.npm-cache/` sekarang: `_cacache` 144M, `node-gyp` 65M, dan `_prebuilds` 2.1M. Disk root host ini masih longgar: 1007G terpakai 36G (4%), jadi ukuran cache ini bukan masalah.

Konsekuensinya kalau `.npm-cache/` dihapus: rebuild berikutnya butuh jaringan lagi untuk mengunduh ulang isi cache, dan di host yang sedang offline build akan berhenti di tengah jalan. `.npm-cache/` sudah masuk `.gitignore`, jadi cache ini tidak ikut ter-commit ke repo.

## Rollback

```bash
dsh plugin --profile web remove dsh-session-readcache
```

Then remove `"dsh-session-readcache"` from `dsh.profile.bundles` if it lingers, and restart the web server.

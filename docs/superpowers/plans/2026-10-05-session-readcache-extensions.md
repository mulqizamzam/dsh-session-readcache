# dsh-session-readcache Extensions A + C Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tambah observability metrics endpoint (A) dan integration test jalur subagent-signal (C) ke plugin dsh-session-readcache.

**Architecture:** Route HTTP didaftarkan lewat `ctx.webServer.register({kind:'exact', ...})` — kontrak yang sama dengan dsh-injection-guard (terverifikasi: `lib/index.js:187-189` injection-guard, dan `packages/host/webserver/tests/webserver.spec.ts:107`). Counter berada di closure `apply()` sehingga handler membaca nilai terkini setiap request. Test C memakai fake service ber-file-temp nyata (sama seperti `tests/logic.mjs`) sehingga jalur `stat`-validasi ikut terbukti.

**Tech Stack:** Node.js >=20, native `http`, ESM. Test baru `.mjs` biasa — tanpa tsx, tanpa dependency baru.

**Spec:** Hasil brainstorming (topik "perluas fitur", keputusan A+C). Gap yang ditutup C: `SECURITY-AUDIT.md` §4 — jalur `persistence.inspect(id, signal)` di `packages/subagent/subagent/src/list-children.ts:382` dan `continuation.ts:954` belum diuji.

## Global Constraints

- Plugin tetap advisory: semua kegagalan di layer cache harus jatuh ke method original; kegagalan register route tidak boleh mematikan boot.
- Tanpa dependency baru; test harus jalan di sandbox dengan `node` saja.
- Jangan restart host (`dsh web`) — restart milik operator. Verifikasi live endpoint = scope terpisah.
- Kontrak desain (bukan bug): pemanggilan `inspect(id, signal)` dengan signal terdefinisi TIDAK pernah di-coalesce (`lib/index.js:62-65`) — signal tidak boleh mewarisi pembatalan orang lain. Test C harus mengunci perilaku ini, bukan mengharapkan folding.
- Semua angka dalam test berasal dari eksekusi, bukan estimasi.

## File Map

| File | Aksi |
|------|------|
| `tests/logic.mjs` | MODIF — mock webServer + 2 test metrics (TDD: gagal dulu) |
| `lib/index.js` | MODIF — register route metrics + dispose di effect |
| `tests/subagent-signal.mjs` | BARU — 5 test jalur signal (regresi BUG-1/BUG-2 + gap §4) |
| `README.md` | MODIF — dokumentasi endpoint metrics |

---

### Task 1: Test metrics (RED)

**Files:**
- Modify: `tests/logic.mjs` (fungsi `makeFake` + array `tests`)

**Interfaces:**
- Consumes: `apply(ctx, {})` dari `lib/index.js`
- Produces: mock `ctx.webServer._registeredRoutes` (array `{kind, path, handler}`) yang dipakai Task 2 sebagai kontrak

- [ ] **Step 1: Tambah mock webServer ke ctx di makeFake()**

Di dalam objek `ctx` di `makeFake()` (setelah baris `logger`), tambahkan:

```javascript
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
```

- [ ] **Step 2: Tambah 2 test baru ke array tests**

```javascript
test('metrics: endpoint registered with exact path', async () => {
  const { ctx } = makeFake()
  apply(ctx, {})
  const routes = ctx.webServer._registeredRoutes
  assert.equal(routes.length, 1, 'one route registered')
  assert.equal(routes[0].kind, 'exact')
  assert.equal(routes[0].path, '/plugin/session-readcache/metrics')
})

test('metrics: counts inspect hits/misses and list hits/misses', async () => {
  const { ctx, service } = makeFake()
  apply(ctx, {})
  await service.inspect('s1') // miss
  await service.inspect('s1') // hit
  await service.list()        // miss
  await service.list()        // hit (TTL 750ms default)
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
```

- [ ] **Step 3: Jalankan — wajib GAGAL**

Run: `node tests/logic.mjs`
Expected: 2 test baru FAIL (`routes.length` = 0), 9 test lama PASS. Exit code 1.

- [ ] **Step 4: Commit test**

```bash
git add tests/logic.mjs
git commit -m "test: RED metrics endpoint contract for session-readcache"
```

---

### Task 2: Implementasi route metrics (GREEN)

**Files:**
- Modify: `lib/index.js` — di dalam callback `ctx.inject(...)`, setelah `Object.defineProperty(target, '__readcacheApplied', ...)` (sekitar baris 159) dan sebelum `process.stderr.write`; cleanup ditambahkan ke callback `ctx.effect` (baris 164-172).

**Interfaces:**
- Produces: `GET /plugin/session-readcache/metrics` → JSON `{"inspect":{"hits","misses","stale","liveSkips"},"list":{"hits","misses"},"cache":{"entries","totalCost","inflight"}}`
- Dispose route dipanggil bersama unmount inspect/list.

- [ ] **Step 1: Register route (setelah defineProperty, sebelum stderr.write)**

```javascript
    // Observability endpoint: read-only live counters (closes: no way to see
    // cache effectiveness without restarting). Registered inside the inject
    // guard so double-apply cannot hit the webserver's duplicate-path throw.
    let disposeMetricsRoute
    if (typeof ctx.webServer?.register === 'function') {
      try {
        disposeMetricsRoute = ctx.webServer.register({
          kind: 'exact',
          path: '/plugin/session-readcache/metrics',
          handler: (_req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({
              inspect: { hits: counters.hits, misses: counters.misses, stale: counters.stale, liveSkips: counters.liveSkips },
              list: { hits: counters.listHits, misses: counters.listMisses },
              cache: { entries: entries.size, totalCost, inflight: inflight.size },
            }))
          },
        })
      } catch (error) {
        ctx.logger?.warn?.(`[session-readcache] metrics route not registered: ${error?.message ?? error}`)
      }
    } else {
      ctx.logger?.warn?.('[session-readcache] webServer unavailable; metrics endpoint not exposed')
    }
```

- [ ] **Step 2: Tambah dispose ke dalam ctx.effect callback (baris pertama di dalam fungsi cleanup)**

```javascript
      try { disposeMetricsRoute?.() } catch { /* route disposal is best-effort */ }
```

- [ ] **Step 3: Jalankan — wajib PASS semua**

Run: `node tests/logic.mjs`
Expected: `ALL 11 PASS`, exit 0.

- [ ] **Step 4: Commit**

```bash
git add lib/index.js
git commit -m "feat: metrics endpoint GET /plugin/session-readcache/metrics with dispose"
```

---

### Task 3: Integration test jalur subagent-signal (C)

**Files:**
- Create: `tests/subagent-signal.mjs`

**Interfaces:**
- Consumes: `apply` dari `../lib/index.js`; pola fake service dari `tests/logic.mjs` (temp file nyata agar `revisionOf`/stat validasi jalan).
- Produces: bukti eksekusi jalur `inspect(id, signal)` yang selama ini hanya tercatat sebagai gap (`SECURITY-AUDIT.md` §4).

Desain kesadaran (bukan bug, `lib/index.js:59-65`): signal terdefinisi → tidak masuk `inflight` → setiap pemanggilan = satu read. Tanpa signal → di-fold.

- [ ] **Step 1: Tulis file test lengkap**

```javascript
// Integration test: the subagent inspect(id, signal) paths —
// packages/subagent/subagent/src/list-children.ts:382 and
// continuation.ts:954 — call with an AbortSignal, so they are never folded
// by the in-flight coalescer (by design: lib/index.js:59-65). This file is
// the execution evidence missing from SECURITY-AUDIT.md §4.
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../lib/index.js'

function makeFake({ inspectDelayMs = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'readcache-sig-'))
  const calls = { inspect: 0 }
  const paths = {}
  for (const id of ['c1', 'c2', 'c3']) {
    paths[id] = join(dir, id)
    writeFileSync(paths[id], 'x')
  }
  const service = {
    get inspectCalls() { return calls.inspect },
    locate: (meta) => ({ kind: 'fake', path: paths[meta.id] }),
    async inspect(id, signal) {
      if (signal?.aborted) throw new Error('aborted before read')
      if (inspectDelayMs) await new Promise((r) => setTimeout(r, inspectDelayMs))
      if (signal?.aborted) throw new Error('aborted mid-flight')
      calls.inspect += 1
      if (paths[id] === undefined) throw new Error(`not found: ${id}`)
      return { meta: { id, cwd: dir, createdAt: 1 }, events: [{ seq: 1, type: 'x' }] }
    },
    async list() { return [] },
  }
  const ctx = {
    inject: (names, cb) => cb({ sessionPersistence: service, sessions: { get: () => undefined } }),
    effect: (fn) => fn(),
    logger: { info: () => {}, warn: () => {} },
    webServer: { register: () => () => {} },
  }
  return { ctx, service, paths, dir }
}

const tests = []
function test(label, fn) { tests.push([label, fn]) }

test('signal: 5 concurrent signalled calls are NOT folded (each does own read)', async () => {
  const { ctx, service } = makeFake()
  apply(ctx, {})
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, (_, i) => service.inspect('c1', new AbortController().signal)),
  )
  assert.ok(results.every((r) => r.status === 'fulfilled'), 'all fulfilled')
  assert.equal(service.inspectCalls, 5, 'signalled callers never coalesce (by design)')
})

test('signal: unsignalled concurrent calls DO fold into one read', async () => {
  const { ctx, service } = makeFake()
  apply(ctx, {})
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, () => service.inspect('c2')),
  )
  assert.ok(results.every((r) => r.status === 'fulfilled'), 'all fulfilled')
  assert.equal(service.inspectCalls, 1, 'unsignalled callers coalesce (BUG-1/BUG-2 fix)')
})

test('signal: signalled reads still benefit from the cache', async () => {
  const { ctx, service } = makeFake()
  apply(ctx, {})
  const first = await service.inspect('c1', new AbortController().signal)
  const second = await service.inspect('c1', new AbortController().signal)
  assert.equal(service.inspectCalls, 1, 'second signalled call hit stat-validated cache')
  assert.equal(first, second, 'same frozen object returned')
})

test('signal: abort before read rejects without poisoning the cache', async () => {
  const { ctx, service } = makeFake()
  apply(ctx, {})
  const ac = new AbortController()
  ac.abort()
  await assert.rejects(() => service.inspect('c1', ac.signal), /aborted/)
  assert.equal(service.inspectCalls, 0, 'aborted call never reached the original')
  const ok = await service.inspect('c1') // unsignalled after abort
  assert.equal(service.inspectCalls, 1, 'cache path still healthy after abort')
  assert.ok(ok.events.length > 0)
})

test('signal: abort mid-flight rejects that caller only', async () => {
  const { ctx, service } = makeFake({ inspectDelayMs: 40 })
  apply(ctx, {})
  const ac = new AbortController()
  const pending = assert.rejects(() => service.inspect('c3', ac.signal), /aborted/)
  setTimeout(() => ac.abort(), 10)
  await pending
  const after = await service.inspect('c3')
  assert.ok(after.events.length > 0, 'later read unaffected by earlier abort')
})

let failed = 0
for (const [label, fn] of tests) {
  try { await fn(); console.log(`PASS ${label}`) }
  catch (error) { failed += 1; console.error(`FAIL ${label}\n  ${error.stack ?? error.message}`) }
}
console.log(failed === 0 ? `ALL ${tests.length} PASS` : `${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
```

Catatan desain fake: `inspect` menghitung `calls.inspect` SETELAH cek signal — pemanggilan yang gagal karena abort tidak dihitung sebagai read (sesuai asersi test 4).

- [ ] **Step 2: Jalankan — wajib PASS sekarang juga**

Run: `node tests/subagent-signal.mjs`
Expected: `ALL 5 PASS`, exit 0. Test ini mengunci perilaku yang SUDAH ada (regresi guard BUG-1/BUG-2 + gap §4); FAIL = regresi nyata, jangan diabaikan.

- [ ] **Step 3: Jalankan suite lama — wajib tetap 11 PASS**

Run: `node tests/logic.mjs`
Expected: `ALL 11 PASS`, exit 0.

- [ ] **Step 4: Commit**

```bash
git add tests/subagent-signal.mjs
git commit -m "test: subagent signal-path inspection evidence (SECURITY-AUDIT §4)"
```

---

### Task 4: Dokumentasi README

**Files:**
- Modify: `README.md` — sisipkan section "## Metrics" setelah tabel Config (setelah baris 44).

- [ ] **Step 1: Sisip section**

```markdown
## Metrics

Live counters, read-only (no auth beyond what the host's web server already applies):

```bash
curl http://127.0.0.1:13080/plugin/session-readcache/metrics
```

```json
{
  "inspect": { "hits": 12, "misses": 5, "stale": 2, "liveSkips": 0 },
  "list": { "hits": 8, "misses": 3 },
  "cache": { "entries": 4, "totalCost": 28473, "inflight": 0 }
}
```

- `inspect.hits/misses` — cache hit vs full disk read.
- `inspect.stale` — entries dropped because the file changed (stat mismatch).
- `inspect.liveSkips` — live sessions refused for caching (correctness guard).
- `list.hits/misses` — TTL reuse vs directory scan.
- `cache.entries` / `cache.totalCost` — current entries and parsed-event budget in use.
- `cache.inflight` — reads currently being folded.

Counters reset on restart. Route is removed on plugin unmount. If `ctx.webServer` is unavailable the plugin logs a warning and runs without the endpoint (advisory, boot never blocks).
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: metrics endpoint"
```

---

## Self-Review (dijalankan saat menulis rencana, temuan sudah diperbaiki inline)

1. **Spek coverage:** A = Task 1+2+4; C = Task 3. Gap §4 tercakup test 1-3 Task 3. ✓
2. **Placeholder scan:** tidak ada TBD/TODO; semua langkah berisi kode utuh. ✓
3. **Konsistensi tipe:** handler metrics membaca `counters` yang dideklarasikan `lib/index.js:38` — dalam scope closure yang sama. Shape JSON di Task 2 identik dengan asersi Task 1. ✓
4. **Koreksi yang dilakukan saat review:** (a) urutan dibalik ke TDD (test RED dulu, baru implementasi); (b) asersi `listMisses: 2` salah (TTL 750ms membuat panggilan cepat kedua = hit), diperbaiki jadi hits 1 / misses 1; (c) draft awal mengharapkan folding pada signalled calls — itu salah paham terhadap kontrak `lib/index.js:59-65`, diubah jadi mengunci perilaku asli; (d) file `.mts`+tsx diganti `.mjs` biasa — tanpa dependency, deterministik di sandbox.

## Verifikasi akhir (di luar scope plan ini, dicatat agar tidak diklaim)

- Endpoint live di `127.0.0.1:13080` baru bisa diuji setelah host memuat kode baru — restart `dsh web` milik operator. Sebelum itu, kontribusi terverifikasi hanya unit/contract test.
- Smoke test `smoke-test.mjs` menyentuh host yang berjalan; tidak dijalankan di sini.

## Execution Handoff

Inline execution dipilih: subagent di host ini terbukti sering tanpa alat tulis (memori operator), dan tiga dari empat task menyentuh file berurutan (`lib/index.js`, `tests/logic.mjs`) — parent jadi satu-satunya penulis. Menggunakan superpowers:executing-plans.

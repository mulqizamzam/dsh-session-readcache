# SECURITY-AUDIT.md — reachability & verification record

Catatan bukti untuk `lib/index.js` (dsh-session-readcache). Berkas ini **tidak** pernah
menyatakan cacat sudah terjadi di produksi. Isinya: apa yang terukur, apa yang
belum, dan koreksi terhadap pengukuran yang pernah salah.

Commit perbaikan: `5be213e` (di atas baseline `ecc8272`).

---

## 1. Fakta kontrak host: tidak ada coalescer per-id

Jejak lengkap dari `session.history` sampai `persistence.inspect`:

| Lokasi | Isi |
| --- | --- |
| `packages/host/apiproxy/src/api-proxy.ts:1474-1479` | `historySourceFor` → `ctx.sessions.get(sessionId)` bila attach, selain itu `inspectServable(sessionId)` |
| `packages/host/apiproxy/src/api-proxy.ts:1197-1198` | `inspectServable` = delegasi satu baris ke `inspectApiRemoteSession` |
| `packages/api/remotes/src/agent-lookup.ts:94-111` | `inspectApiRemoteSession`: `persistence.list()` → `.find()` → `await persistence.inspect(sessionId)` → return |

Nol `Map`, nol dedup key, nol promise cache, nol in-flight collapse di sepanjang
jalur itu. Satu-satunya `Map` di `agent-lookup.ts` adalah
`resumes = new Map<SessionId, Promise<Agent>>()` (`:125`) milik
`createApiRemoteAgentResolver` — resolver **agent** untuk cold resume, tidak
dipakai `history`. Dua pemanggil `inspectServable` lainnya (`:1448`, `:2591`)
berbentuk sama: attach-atau-inspect, tanpa coalescer.

Yang satu-satunya short-circuit per-id di host adalah `ctx.sessions.get()` — sesi **attach**.
Itu perilaku sah (events-nya sudah di memori), bukan dedup.

## 2. Reachability

**Terbuka untuk BUG-2: reachable via `session.history` pada sesi detached.**

Dasarnya terukur, bukan sekadar struktur: pada build pra-fix, 8 baca konkuren untuk
satu id yang sama menghasilkan 8 `insert-add` terhadap **satu** entri, dan
drift `7 × 5228`. Versi yang lebih panjang dari beban 24-event menghasilkan 4
`insert-add` per id dan `error` 76.693 pada `trueSum` 28.473.

Syaratnya: sesi harus **detached**. Sesi attach tidak menyentuh
`persistence.inspect` sama sekali.

Kata "shipped" sengaja tidak dipakai di sini. Reachability terbuka berarti cacat
dapat terjadi, bukan berarti sudah terjadi pada frekuensi tertentu di produksi —
frekuensi itu belum pernah diukur pada proses GUI yang sedang berjalan.

## 3. Pengukuran A/B — guard terbukti eksekusi

Dua lengan, instance terisolasi yang sama (kode host sama, log sesi asli, RPC
HTTP asli), hanya coalescing yang di-toggle lewat `RC_NO_COALESCE`. Beban identik:
8 baca konkuren untuk satu id, lalu `touch` mtime dan 8 baca konkuren lagi.

| Ukuran | Lengan A — coalescing MATI | Lengan B — coalescing AKTIF |
| --- | --- | --- |
| `inspectRead` dipanggil | **8** | **2** |
| `insert-add` | **8** | **2** |
| `drop-attempt` | 8 | 1 |
| — menang (`stillOurs: true`) | **1** | 1 |
| — **ditolak (`stillOurs: false`)** | **7** | 0 |
| `drop-subtract` nyata | **1** | **1** |
| `totalCost` akhir | 5228 | 5228 |
| `trueSum` akhir | 5228 | 5228 |
| **ERROR** | **0** | **0** |

Dua hal yang dibuktikan angka ini:

1. **Guard eksekusi, bukan sekadar ada.** Di lengan A ada 8 penolakan dengan
   `stillOurs: false` dan tepat satu pengurangan. Kalau guard tidak ada,
   `totalCost` akan anjlok 7 × 5228 = 36.596 di bawah nol. Yang terjadi: 0.
2. **Coalescing tidak tunggal.** 8 → 2 `inspectRead`. Sisa 2 adalah satu untuk
   tiap putaran baca, bukan 8.

Bukti mentah: `artifacts/live/EVIDENCE-guard-rejections.jsonl` (lengan A) dan
`artifacts/live/EVIDENCE-coalesce-on.jsonl` (lengan B).

## 4. Kenapa guard ada kalau coalescing sudah menutup jalur RPC

`inspectApiRemoteSession` memanggil `persistence.inspect(sessionId)` **tanpa
argumen kedua**, jadi di dalam plugin `signal` selalu `undefined` dan coalescing
selalu berlaku pada jalur RPC. Guard adalah **backstop** untuk pemanggil yang
menyertakan signal dan karena itu tidak dilipat:

- `packages/subagent/subagent/src/list-children.ts:382` — `persistence.inspect(childId, signal)`
- `packages/subagent/subagent/src/continuation.ts:954` — `persistence.inspect(childId, options.signal)`

**Kedua jalur ini belum diuji end-to-end.** Guard di sana baru diuji oleh
`tests/logic.mjs` (9/9) dan tes regresi pembukuan. Belum ada bukti eksekusi di
jalur subagent. Lengan A di atas membuktikan guard bekerja ketika para racer
benar-benar ada — yang persis kondisi dua pemanggil itu — tapi belum membuktikan
keduanya pernah sampai ke sana dalam pemakaian nyata.

## 5. Koreksi terhadap pengukuran sendiri

Sebelumnya dilaporkan: "6 RPC dengan signal menghasilkan 0 `ENTER` di
persistence.inspect", dan itu sempat dikira bukti adanya coalescer di host.

**Itu salah ukur, bukan temuan.** `inspectApiRemoteSession` tidak pernah
meneruskan `AbortSignal` ke `persistence.inspect`, jadi keenam request itu masuk
dengan `signal === undefined` dan **dilipat oleh coalescing milik fix itu
sendiri**. Jejak mencatat `hasSignal: false` pada `ENTER` yang menyusul, yang
justru membuktikan hal itu. Hal itu diubah menjadi A/B di atas: penyebabnya
adalah coalescing kita, bukan coalescer host.

Kontradiksi "4 insert-add per id pra-fix vs 0 pasca-fix" juga dijelaskan oleh
A/B yang sama — pra-fix tidak punya coalescing sama sekali, pasca-fix punya.

## 6. Angka mana yang bukan apa

`error` selalu dihitung `totalCost − trueSum`. Dua titik waktu dari build yang
sama, bukan dua build:

| Titik | totalCost | trueSum | error |
| --- | --- | --- | --- |
| akhir beban 24-event (pra-fix) | 105.166 | 28.473 | **76.693** |
| setelah eksperimen drop/mtime (pra-fix) | 126.078 | 28.473 | **97.605** |

Angka "3,69×" berasal dari titik pertama. Itu besaran terukur dari drift
pembukuan pada satu window — **bukan** bukti bahwa drift bersifat permanen di
produksi; itu masih terbuka dan tidak diuji di host GUI yang berjalan.

## 7. Batas pengujian

- Semua pengukuran runtime dilakukan pada **replika terisolasi** (DSH_HOME
  sendiri, port 13099, log sesi asli yang disalin). Proses GUI pada port 13080
  tidak pernah diinstrumentasi dan tidak pernah direstart.
- `node --test tests/` keluar 1 di **kedua** commit (`ecc8272` dan `5be213e`):
  berkas-berkas `tests/` bukan suite `node:test`. Pre-existing, bukan regresi.
  Suite yang dipakai repo adalah `node tests/logic.mjs` → 9/9, exit 0.
- `anti-ai-ui-builder/package.json` (aktor lain sedang mengeditnya saat
  investigasi) dicek tiga kali spanning 60 detik: mtime `1790774500` tidak
  bergeser. Tetap stabil per pemeriksaan terakhir; periksa ulang sebelum restart.

## 8. Divergensi pembatalan pada jalur cache-hit (diperbaiki, terukur)

Bug lama BUG-5 ("`AbortSignal` diabaikan di jalur cache hit") **masih terbuka sampai
HEAD `04511cd`** dan kini ditutup. Bukti eksekusinya ada, bukan bacaan kode.

**Yang diukur.** Dua probe (`artifacts/orchestrator/repro-abort-hit.mjs`,
`repro-abort-midstat.mjs`) pada `04511cd`: exit **1** pada keduanya. Sinyal yang
sudah dibatalkan terhadap cache hangat **fulfilled** dengan isi sesi, sedangkan
kontrol cache dingin pada probe yang sama melempar. Host (`coordinator.ts:789`)
menolak di statement pertama setiap panggilan.

**Kontrak host yang dilanggar.** Bukan interpretasi: ada *shared contract test*
`packages/session/session-persistence/tests/contract.ts:280-291`
("rejects pre-aborted observation reads with the exact cancellation reason")
yang menguji `inspect(...)` menolak dengan identitas reason. Lapisan cache host
sendiri juga menolak pada hit (`preparations.ts:59-61` + `observeQueuedAbort`).

**Perbaikan.** `signal?.throwIfAborted()` sebagai statement pertama
`inspectRead`, dan sekali lagi sesudah `await revisionOf`. Yang pertama juga
menutup celah kedua yang ditemukan BREAKER: sebelum perbaikan, pemanggil yang
sudah dibatalkan pada cache dingin tetap membayar *scan direktori* `list()` untuk
mencari path log sebelum delegasi. Terukur pada beban 400 baca: `inspect.misses`
turun **62 -> 48**, `list.misses` tetap **1**.

**Koreksi terhadap catatan sendiri.** Draft pertama menulis
`waitForInitialPromptDurability` sebagai fungsi di `roster.ts:347` — nama itu
tidak ada di repo; yang benar `checkpointInitialPrompt` (`roster.ts:338`).
Draft itu juga menyatakan `roster.ts:399` tidak memeriksa ulang abort; **salah**
— `roster.ts:414` memanggilnya tanpa syarat. Kedua koreksi diverifikasi ulang
terhadap sumber.

**Reachability (terverifikasi).** Dua pemanggil yang benar-benar tidak memeriksa
ulang abort setelah `inspect` ter fulfil: `agent-team/src/roster.ts:347`
(accept branch) dan `mailbox.ts:329`. Keduanya berada di
`packages/experimental/agent-team`, yang **tidak** masuk boot default
(`scripts/release/families.spec.ts:48` memastikan tidak ada di release family).
Enam pemanggil lain semuanya melakukan pemeriksaan ulang. Jadi: kontrak dilanggar,
gejala belum terlihat di profil default.

## 9. Batas yang tidak ditutup

- **Barrier `waitForRetirement`** (BUG-3) tetap tidak dipasar di jalur hit.
  `retirements` adalah `private` (`coordinator.ts:594`) dan plugin hanya memegang
  backend, jadi tidak dapat diamati dari posisi plugin — koreksi atas teks
  remediasi lama di `artifacts/REPORT.md:289` yang menyiratkan cukup "replikasi
  validasi host". Butuh permukaan API baru di host.
- **Pembatalan tidak cepat.** `throwIfAborted()` sesudah `await` hanya melihat
  abort yang selesai sebelum `stat` selesai; host memakai `observeQueuedAbort`
  yang menolak pada *event*. Selama `fs.stat` menggantung, perilakunya berbeda.
  Seberapa sering `stat` menggantung pada deployment ini belum diukur.
- **`tests/runtime-smoke.mjs`** (BUG-6) masih keluar 0 tanpa pernah menjalankan
  subjeknya. Tidak disentuh oleh perubahan ini.

# HOST TICKET — `projections.sessionListMetadata` pada jalur cold `session.list`

**Status:** Draft untuk owner host (`/home/administrator/deepseek-harness`).
**Dialokasikan oleh:** plugin `dsh-session-readcache`.
**Tanggal penulisan:** oleh agen (investigasi terukur, bukan eksekusi).

---

## 1. Ringkasan

1. **Masalah:** `session.list` pada host produksi memakan 9,0–10,2 detik per RPC.
2. **Angka terukur:** 3.852 log sesi / 1,68 GB di `/home/administrator/agent-workspace/.dsh/sessions`; sampel RPC `session.list` 9,760 / 10,300 / 9,117 / 12,070 / 8,766 / 9,663 / 10,232 / 9,029 ms; scan header serial 9,761 ms cold dan 2,703–3,007 ms warm; scan 32-way paralel 1,429 ms; full decode 30-log 7,3 ms/log dengan output rata-rata 1.686.570 B.
3. **Akar sebab (hipotesis yang dibawa tiket ini):** `projections.sessionListMetadata` tidak ada di header mana pun, sehingga `summarizeCold` tidak bisa skip blank probe dan `probeColdSessionMetadata` decode penuh tiap log.
4. **Dampak (hipotesis):** ~28,1 s serial ÷ 16-way = ~1,8 s per RPC, di luar jangkauan cache plugin karena loop berada di luar `persistence.list()`.
5. **Yang diminta:** tulis `projections.sessionListMetadata` ke header saat sesi dibuat/di-update.

> ### ⚠️ Koreksi hasil verifikasi — baca sebelum poin 3 sampai 5
>
> Verifikasi kode dan data sebelum menulis tiket ini **membatalkanhipotesis pada poin 3–5**. Tiga temuan:
>
> - **A. Penulis `sessionListMetadata` ADA**, bukan tidak ada: `api-proxy.ts:1232-1241` mendaftarkannya sebagai unit proyeksi, dan `@deepseek-ai/dsh-session-projection-cache` mem-persist-nya.
> - **B. Proyeksi memang tidak ada di header** — tapi itu **memang desain**, bukan bug: `SessionHeader` (`packages/core/session/src/types.ts:61-99`) tidak punya field `projections` sama sekali. Nilainya disimpan di store terpisah, `storages/session_projcache.json`.
> - **C. Gerbang ukuran membuat probe tidak mungkin menyentuh 3.853 log.** `probeColdSessionMetadata` berhenti di `api-proxy.ts:532` (`if (size > maxBytes) return undefined`, default **1.024 B**). Hanya **39 dari 3.862** log yang ≤1.024 B.
>
> Konsekuensi: hitungan "3.853 × 7,3 ms ≈ 28,1 s" tidak dapat terjadi — 3.823 log dikeluarkan gerbang sebelum `readFrom` dipanggil. Detail, angka, dan metode di bagian 2.
>
> **Rekomendasi:** jangan kerjakan poin 5 apa adanya. Lihat bagian 4 (usulan yang direvisi) dan bagian 7 (resolusi cold-vs-warm).

---

## 2. Tabel evidence

### 2.1 Angka yang dibawa brief (Label: `[OBSERVED]` — hasil investigasi sebelumnya)

| # | Angka | Cara ukurnya | Label |
|---|---|---|---|
| E1 | 3.852 log sesi, 1,68 GB | Enumerasi direktori `/home/administrator/agent-workspace/.dsh/sessions` | `[OBSERVED]` |
| E2 | Scan header serial: 9,761 ms cold; 2,703–3,007 ms warm | Kutip helper zstd host (`packages/session/session-persistence-jsonl/src/zstd.ts`), loop serial seluruh corpus | `[OBSERVED]` |
| E3 | Scan 32-way paralel: 1,429 ms | Scan yang sama, dinaikkan ke konkurensi 32 | `[OBSERVED]` |
| E4 | RPC `session.list`: 9,0–10,2 s (8 sampel: 9,760 / 10,300 / 9,117 / 12,070 / 8,766 / 9,663 / 10,232 / 9,029) | Panggilan RPC langsung ke host produksi | `[OBSERVED]` |
| E5 | `projections.sessionListMetadata` ada di **0 dari 3.852** header | Baca dan parse seluruh header log tersimpan | `[OBSERVED]` |
| E6 | Full decode 30 log: 7,3 ms/log, output rata-rata 1.686.570 B | Sampel 30 log, decode penuh | `[OBSERVED]` |
| E7 | 7,3 ms × 3.853 ≈ 28,1 s serial; ÷ `COLD_SUMMARY_BATCH_SIZE`=16 → ~1,8 s | Aritmetika turunan dari E6 | `[OBSERVED — turunan]` |

### 2.2 Angka verifikasi ulang oleh agen (Label: `[OBSERVED-VERIFIKASI]`)

| # | Angka | Cara ukurnya | Label |
|---|---|---|---|
| V1 | **Hanya 39 dari 3.862 log** yang ukurannya ≤1.024 B (p50 220.522 B, p90 1.111.494 B, maks 7.843.726 B) | `stat` seluruh file `session.jsonl.zstd` | `[OBSERVED-VERIFIKASI]` |
| V2 | **3.823 dari 3.862 log** dikeluarkan oleh gerbang ukuran di `api-proxy.ts:532` | Turunan dari V1 + ambang `DEFAULT_COLD_BLANK_PROBE_MAX_BYTES = 1024` (`api-proxy.ts:123`) | `[OBSERVED-VERIFIKASI — turunan]` |
| V3 | `storages/session_projcache.json` berisi **4.316 baris**, **4.316 di antaranya punya `sessionListMetadata`**; 4.275 `blank=false`, 43 `blank=true` | Baca + parse `tables.sessions` | `[OBSERVED-VERIFIKASI]` |
| V4 | Semua baris memakai `ver: 1`, cocok dengan `stateVersion: 1` (`api-proxy.ts:1239`) | `version checkpointRow` | `[OBSERVED-VERIFIKASI]` |
| V5 | **3.836 header Cocok, 0 Mismatch, 26 tanpa baris cache** dari 3.862 header | `identityMatches(createdAt, cwd)` (`session-projection-cache/src/index.ts:294-296`) terhadap tiap header tersimpan | `[OBSERVED-VERIFIKASI]` |
| V6 | Scan header dengan **kode host sendiri** (`readFirstZstdLine`): **2.107 ms cold / 2.086 ms warm** untuk 3.864 file | `node --import tsx`, memanggil `scanZstdFrames` + `decompressZstdFrame` asli dari repo host | `[OBSERVED-VERIFIKASI]` |
| V7 | 3.862 log; hanya **43** baris cache `blank=true` dan **0 di antaranya** punya file log ≤1.024 B | Persilangan V1 dan V3 | `[OBSERVED-VERIFIKASI — turunan]` |

---

## 3. Mekanisme kode

### 3.1 Jalur yang dicurigai brief

**`packages/host/apiproxy/src/api-proxy.ts:1666-1726`** — `listVisibleSessionSummaries()`:

- `api-proxy.ts:1676` — sesi ter-attach disummarize dari memori.
- `api-proxy.ts:1681` — `persistence.list(signal)` membaca header semua sesi cold.
- `api-proxy.ts:1684-1687` — dipecah per batch `COLD_SUMMARY_BATCH_SIZE = 16` (`api-proxy.ts:121`), `Promise.allSettled`.
- `api-proxy.ts:1691-1699` — tiap baris cold mengambil proyeksi lalu memanggil `summarizeCold(...)`.

**`api-proxy.ts:544-566`** — `summarizeCold()`, kondisi skip di **`:553-555`**:

```ts
const probed = metadata?.blank === false
  ? undefined
  : await probeColdSessionMetadata(ctx, persistence, meta, blankProbeMaxBytes, signal)
```

**`api-proxy.ts:513-542`** — `probeColdSessionMetadata()`:
- `:520` — `maxBytes === 0` → selesai.
- `:532` — **`if (size > maxBytes) return undefined`** ← gerbang yang menentukan.
- `:534` — `persistence.readFrom(meta.id, 0, signal)` — decode penuh log.
- `:536` — `sessionListMetadata(events)`.

### 3.2 Yang sebenarnya terjadi (bertentangan dengan 3.1)

**Proyeksi cold TIDAK dibaca dari header.** `api-proxy.ts:798-808` — `listProjectionsFor()`:

```ts
const block = session !== undefined
  ? ctx.get('sessionProjections')?.snapshot(session)      // attach: memori
  : ctx.get('sessionProjectionCache')?.cachedSnapshot(meta) // cold: cache
```

Untuk sesi cold, sumbernya `sessionProjectionCache.cachedSnapshot()` (`session-projection-cache/src/index.ts:119-130`) — **bukan** field header. Karena itu E5 ("0 dari 3.852") benar secara harfiah tetapi tidak relevan: header memang tidak pernah membawa proyeksi.

**Cache itu terisi dan terbaca.** V3/V4/V5: 4.316 baris, seluruhnya `ver: 1`, 3.836 identitas cocok. Artinya `metadata.blank === false` berlaku untuk 4.275 baris → cabang `api-proxy.ts:553` **sudah** melewati probe untuk sebagian besar sesi.

**Dan ketika tidak skip, gerbang ukuran menahan.** `DEFAULT_COLD_BLANK_PROBE_MAX_BYTES = 1024` (`api-proxy.ts:123`, dipakai di `api-proxy.ts:1050-1051`). V1/V2: 3.823 dari 3.862 log melebihi 1.024 B → `api-proxy.ts:532` mengembalikan `undefined` **sebelum** `readFrom`.

V7 menutup lubangnya: dari 43 baris `blank=true`, **0** punya artefak ≤1.024 B. Jadi pada korpus ini, `readFrom` di `api-proxy.ts:534` praktis tidak terjangkau.

### 3.3 Penulis yang sebenarnya ada

- `api-proxy.ts:452-461` — `applySessionListMetadata()`, fold satu event.
- `api-proxy.ts:1232-1241` — registrasi unit `sessionListMetadata` (`init`, `apply`, `stateVersion: 1`).
- `session-projection-cache/src/index.ts:200-238` — `installWritePath()` menulis write-behind di `turn/end` (`:205`), `session/disposed` (`:225`), plus ambang jumlah/interval (`:212`, `:216`).
- `session-projection-cache/src/index.ts:140-152` — `write()`: checkpoint + `flush()` lalu `put()`.
- Komposisi: `packages/bundle/web-app/cordis.patch.yml:76-80` — `writeEveryEvents: 200`, `writeIntervalMs: 5000`.

### 3.4 Sumber biaya yang masih berdiri

E4 (9,0–10,2 s per RPC) adalah fakta. Yang tidak tahan adalah penjelasan sebab-akibatnya. Yang terukur ada dua:

- Scan header serial adalah kerja nyata dan berskala detik (E2, V6). `persistence.list()` pada `api-proxy.ts:1681` memanggilnya setiap RPC tanpa memo di host.
- Justru jalur ini **tidak** dikendalikan `summarizeCold`; ini persis yang di-cache oleh `dsh-session-readcache` (plugin wrap `list()`, lihat `lib/index.js:128`).

---

## 4. Usulan fix host

### 4.1 Usulan utama (revisi dari brief)

**Jangan tulis `projections.sessionListMetadata` ke header.** Alasannya terverifikasi:

1. `SessionHeader` (`packages/core/session/src/types.ts:61-99`) adalah kontrak on-disk **bers versioning** dengan `SESSION_FORMAT_VERSION = 0` dan kebijakan **tanpa migrasi** (`types.ts:63-66`). Menambah field = perubahan format persisted.
2. Cache proyeksi sudah dibangun persis untuk kebutuhan ini dan sudah berisi 4.316 baris (V3). Menulis ke header akan menduplikasi sumber informasi yang sudah ada.
3. Nilainya tidak ada gunanya di header: `api-proxy.ts:800-802` **tidak pernah** membaca proyeksi dari header pada jalur cold.

Yang layak dipertimbangkan owner (bukan tiket ini yang memutuskan):

- **Opsi A — majukan pembacaan header secara paralel.** `listArtifacts()` (`session-persistence-jsonl/src/index.ts:472-512`) membaca header satu per satu (`:490-493`). Batas paralel seperti yang sudah diukur (E3: 1,429 ms pada 32-way) adalah kandidat yang sudah ada angka pendukungnya.
- **Opsi B — memo host di `persistence.list()`.** Cegah scan ulang header yang identik dalam jendela waktu pendek. Perlu kontrak invalidasi (kapan log berubah).
- **Opsi C — turunkan `COLD_SUMMARY_BATCH_SIZE`.** `api-proxy.ts:121` = 16. Tidak ada angka terukur untuk nilai alternatif — **belum ditentukan**.

### 4.2 Opsi alternatif yang dipertimbangkan dan ditolak

**Cache hasil probe di sisi plugin.** Secara teknis mungkin, tapi **menyalahi batas kepemilikan plugin**:

- Plugin wrap `persistence.list()` (`lib/index.js:128`), sedangkan `probeColdSessionMetadata` berjalan di `api-proxy.ts:1692`, **di luar** fungsi yang di-wrap. Plugin tidak bisa menaruh hasil probe ke dalam loop itu tanpa menyalin logika internal host — setiap perubahan `summarizeCold`/`probeColdSessionMetadata` di host diam-diam membuat cache plugin basi.
- Lebih mendasar: `blank` bersifat monoton (`sessions.ts:26-28` — `blank: false` monoton dan boleh menekan probe; `blank: true` hanya fakta awalan checkpoint dan tidak boleh menyembunyikan sesi cold tanpa verifikasi langsung). Menyimpan keputusan itu di luar host memindahkan **kebijakan** ke lapisan yang tidak memiliki kontrak header.

### 4.3 Risiko

- **Risiko utama proposal brief (header `projections`):** mengubah `SessionHeader` yang ter-versioning tanpa jalur migrasi; membuat dua sumber kebenaran (header vs cache) yang bisa berbeda pada `cwd` yang berubah atau sesi yang dibuat ulang dengan id yang sama; dan `identityMatches` (`session-projection-cache/src/index.ts:294-296`) saat ini hanya mengikat `createdAt` + `cwd` — field baru perlu aturan invalidasi sendiri.
- **Stale `blank` (untuk opsi apa pun yang menulis state turunan):** nilai `blank` boleh basi hanya jika `blank: true`, dan itu sudah ditangani — `api-proxy.ts:553-555` memverifikasi ulang lewat probe sebelum menyembunyikan. Menulis `blank: false` yang basi akan **menyembunyikan percakapan**; menulis `blank: true` yang basi hanya membazirkan penghematan. Karena itu urutan monotonic `blank: true → false` di `applySessionListMetadata` (`api-proxy.ts:454`) harus dipertahankan.
- **Gatekeeping:** `api-proxy.ts:508-512` menyatakan kontraknya eksplisit — daftar tidak boleh pernah menyembunyikan percakapan hanya karena cache hint. Setiap fix harus menjaga itu.

### 4.4 Yang harus diuji kalau fix diterapkan

1. **Regresi konkurensi:** `session.list` pada dua sesi yang sama saat satu sedang `turn/end` — tidak boleh ada yang hilang dari daftar.
2. **Sesi blank:** sesi yang benar-benar kosong (mis. hanya `/plan`) tetap `blank: true` dan tidak muncul di daftar.
3. **Cold read setelah restart:** `cachedSnapshot` menyertakan uji identitas (V5: 3.836 cocok); ganti `cwd` atau buat ulang id harus membuat baris ditolak, bukan dipakai.
4. **Ukuran artefak:** log tepat di bawah dan tepat di atas 1.024 B (V1) — pastikan ambang batas tetap di posisinya dan tidak ada probe yang lolos tanpa sengaja.
5. **Fail-soft:** `readFrom` yang gagal harus tetap menyajikan sesi sebagai terlihat (`api-proxy.ts:537-541`).
6. **Perbaikan `ver`:** `stateVersion` naik → baris `ver` lama dibuang saat baca (`checkpointRow` di `spec.ts`), bukan dimigrasikan.

---

## 5. Batasan jujur

- **Host ini bukan milik plugin.** `/home/administrator/deepseek-harness` adalah clone upstream dengan remote `https://github.com/deepseek-ai/deepseek-harness.git` dan sudah memiliki suntingan lokal (`git status` menunjukkan `apps/cli/config/agent-presets/cordis/skills/*`, `packages/_custom/`, `packages/extensions/anti-slop-shadow/`, `scripts/cache-baseline/`, dan lain-lain). Setiap suntingan lokal di `packages/host/` akan **berkonflik saat `git pull`**.
- **Karena itu tiket ini tidak dieksekusi oleh agen.** Tidak ada satu baris pun di host yang saya ubah. Verifikasi saya hanya membaca (`read`, `grep`, dan eksekusi kode host pada corpus read-only).
- **Tidak ada benchmark sesudah-fix.** Tidak ada yang diukur "sebelum vs sesudah" karena tidak ada fix yang diterapkan.
- **Eksperimen saya read-only.** Semua skrip dijalankan dari `/tmp`/inline; satu-satunya file yang ditulis adalah dokumen ini.
- **Angka E1–E7 tidak saya ulang ukur** — saya menerima apa adanya dari investigasi sebelumnya dan menandinya masing-masing dengan label `[OBSERVED]` di tabel 2.1.
- **V6 (2.107 ms) lebih kecil dari E2 (9.761 ms).** Dua run di proses berbeda terhadap korpus yang sama; uji ulang menunjukkan run pertama dalam satu proses ~8.800 ms dan run berikutnya ~2.000 ms, jadi selisihnya status page cache. Keduanya milidetik, keduanya orde detik. Terpecahkan di bagian 7.

---

## 6. Belum ditentukan

**Apakah `sessionListMetadata` seharusnya ditulis saat close, saat append, atau saat create?**

**Jawabannya: belum ditentukan** — dan bukan karena tidak ada yang menulis, melainkan karena **tidak ada kontrak untuk menulis ke header sama sekali** (`SessionHeader` tidak punya field `projections`; bagian 3.2).

Yang bisa dinyatakan sebagai fakta:

- Untuk **cache proyeksi**, kontraknya sudah tertulis dan tidak mengizinkan tebakan: titik tulis wajib adalah `turn/end` dan `session/disposed` (`session-projection-cache/src/index.ts:200-238`), dengan dua trigger throttle yang **`belum ditentukan`** nilainya per deployment (`writeEveryEvents`, `writeIntervalMs`; di komposisi bawaan `200` dan `5000` pada `packages/bundle/web-app/cordis.patch.yml:76-80`).
- Untuk **header**, tidak ada titik tulis yang ditetapkan sama sekali.

**Asumsi yang harus dinyatakan jika owner memutuskan menulis ke header:**

- close, append, atau create — **pilihan owner, belum ditentukan di sini**; tiga konsekuensi berbeda:
  - *create* → header besar sejak awal tapi belum tahu `blank` final.
  - *append* → header ditulis ulang per event; urutan dan aturan determinisme serialisasinya belum ditetapkan.
  - *close* → satu kali tulis, tetapi `session.list` untuk sesi yang belum ditutup tetap tanpa proyeksi.
- Asumsi kedua: bahwa header boleh menyimpan data turunan yang bisa basi — saat ini `SessionHeader` dideskripsikan sebagai "Immutable validated storage metadata, kept outside the conversation event log" (`types.ts:58-60`); proyeksi justru **turunan** dan bisa basi.
- Karena kedua asumsi itu belum diuji, angka penghematan setelah fix pun **belum ditentukan**.

---

## 7. Kesimpulan uji ulang: satuan E2 benar, selisih E2 vs V6 adalah page cache

Bagian ini awalnya menandai E2 "9.761 ms" sebagai salah ketik ke "9.761 s". Uji ulang dengan kode host sendiri (3.864 file, `scanZstdFrames` + `decompressZstdFrame` asli, tiga kali berurutan dalam satu proses) menghasilkan:

| run | waktu | status page cache |
| --- | --- | --- |
| 1 | **8.800 ms** | cold (baca dari disk) |
| 2 | **2.200 ms** | warm |
| 3 | **1.983 ms** | warm |

Jadi keduanya benar dan keduanya dalam milidetik. E2 = **9.761 ms** adalah run cold (kohort 3.847 file); V6 = **2.107 ms** adalah run warm. Dugaan "salah ketik" di paragraf sebelumnya DITOLAK: selisih 4,4x itu murni cache halaman, bukan kesalahan satuan. Sesuai temuan ini, `lib/index.js` sudah menyebut kedua orde (`measured 9,761 ms for 3,847 logs` untuk cold, dan `2.7–3.0 s` warm di README).

Kesimpulan yang tetap berdiri: **biaya dominan adalah scan header serial di `persistence.list()`**, dan ia berskala detik pada cold run maupun lebih dari 750 ms pada warm run — keduanya jauh melewati TTL 750 ms, sehingga memo tanpa stale window tidak akan pernah tersentuh.

Nomor lain yang perlu diseragamkan: "3.853 log" pada E7 versus 3.852 pada E1. Uji ulang menghitung **3.864 file** — corpus tumbuh tiap ada sesi yang dibuat (tiap run smoke test `smoke-test.mjs` membuat satu sesi), jadi selisih kecil itu pergerakan korpus, bukan inkonsistensi pengukuran. Angka manapun yang dikutip harus disebutkan kapan diukurnya.

---

## 8. Ringkasan klaim

**Berdasar pengukuran:**
- 3.862 log, hanya 39 yang ≤1.024 B (V1) → gerbang `api-proxy.ts:532` mengeluarkan 3.823 log (V2).
- Cache proyeksi berisi 4.316 baris, semua punya `sessionListMetadata`, semua `ver: 1` (V3, V4).
- 3.836 identitas cocok, 0 mismatch (V5).
- 0 dari 43 baris `blank=true` punya artefak ≤1.024 B (V7).
- Scan header lewat kode host (V6): 2.107 ms dan 2.086 ms — keduanya run WARM, sesuai uji ulang yang membuktikan run pertama dalam satu proses menghabiskan ~8.800 ms (bagian 7).
- Uji ulang scan 3.864 file dalam satu proses: **8.800 ms (pertama) → 2.200 ms → 1.983 ms** [OBSERVED].

**Berdasar kode (bukan angka):**
- `SessionHeader` tidak punya field `projections` (`types.ts:61-99`).
- Jalur cold membaca proyeksi dari cache, bukan header (`api-proxy.ts:800-802`).
- Penulis `sessionListMetadata` ada: `api-proxy.ts:1232-1241` + `session-projection-cache/src/index.ts:200-238`.

**Inferensi (berlabel):**
- E7 "28,1 s → ~1,8 s" tidak dapat terjadi (turunan dari V1/V2).
- Biaya dominan `session.list` adalah scan header serial di `persistence.list()`, bukan probe (E2/V6 vs V2).

**Belum ditentukan:**
- Kontrak titik tulis header (create/append/close) — bagian 6.
- Nilai alternatif `COLD_SUMMARY_BATCH_SIZE` dan konkurensi scan.
- Selisih jumlah file antar run (3.847 / 3.852 / 3.853 / 3.864): korpus bertambah tiap sesi baru dibuat, jadi angka lama jangan dikutip tanpa tanggalnya.
**Tidak diukur sama sekali:**
- Setiap klaim "sesudah fix". Tidak ada fix yang diterapkan.

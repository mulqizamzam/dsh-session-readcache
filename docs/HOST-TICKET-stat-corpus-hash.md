# HOST TICKET: `SessionPersistence.stat(id)` terlalu mahal, dan tidak bisa dijawab saat dispose

**Status:** Selesai di sisi host 2026-10-21, commit `1b1b35b31d` pada
`/home/administrator/deepseek-harness`: `SessionPersistenceStatOptions` gaining
`source?: 'tracked' | 'disk'`, dan backend jsonl yang melewati tracker kalau
opsinya `'disk'`. Spec `packages/session/session-persistence-jsonl/tests/stat-disk-source.spec.ts`
lolos 3/3 (`vitest run`), dan typecheck repo lolos saat push. Build sudah
terjalan lewat pre-push hook, jadi `lib/` host sudah memuat perubahan ini; host
yang sedang hidup masih memakai build lamanya dan butuh restart.
**Dialokasikan oleh:** plugin `dsh-session-readcache`.
**Tanggal penulisan:** 2026-10-21, oleh agen (investigasi terukur, bukan eksekusi).

---

## 1. Ringkasan

Ada dua hal pada `stat(id)` yang sama-sama menyulitkan pemanggil satu-sesi.

1. **Untuk log generasi-0, satu pertanyaan satu sesi menghitung hash SELURUH
   korpus.** `stat()` memanggil `historicalCorpusRevision()`, yang
   meng-enumerate lalu `stat()`-kan setiap log generasi di korpus sebelum
   meng-hash-nya. Untuk satu sesi, 5.343 `readdir` plus 5.343 `stat`.
2. **Untuk sesi yang belum pernah ditulis, `stat()` menjawab dari tracker
   in-memory, bukan dari disk.** Tracker itu masih memegang sesinya pada saat
   event `session/disposed` dipancarkan, jadi pertanyaan "apakah host masih
   menanyakan sesi ini?" yang diajukan saat dispose tidak bisa dijawab: host
   menjawab "ya" justru karena host masih menanyakannya.

Angka terukur untuk butir 1:

| Yang diukur | Angka |
| --- | --- |
| `stat(id)` id dikenal, log generasi-4 (25% sesi) | min 30,4 ms, median **39,7 ms**, max 67,1 ms |
| `stat(id)` id dikenal, log generasi-0 (75% sesi) | min 1,69 detik, median **1,96 detik**, max 3,00 detik |
| `stat(id)` id TIDAK dikenal | min 31,9 ms, median **46,4 ms**, max 77,3 ms |
| Satu scan `list()` penuh, pembanding | 9,7 / 10,4 / 12,4 detik pada run terakhir |

Rasio `stat` terhadap `list()` bergerak antar-run karena pembaginya bergerak:
**1:5,3 sampai 1:11** untuk kelas generasi-0 dan **1:260 sampai 1:520** untuk
kelas generasi-4. Yang stabil adalah biaya `stat()`-nya sendiri: 29-40 ms untuk
generasi-4 dan 1,4-2,0 detik untuk generasi-0.

**Yang diminta:**

1. Apakah revisi korpus itu benar-benar perlu di jalur `stat()`, dan kalau
   perlu, bagaimana hash itu bisa dipakai ulang tanpa dihitung ulang untuk
   setiap panggilan satu-sesi.
2. Apakah ada cara memeriksa "apakah artifact sesi ini benar-benar ada di disk"
   yang mengabaikan tracker in-memory, sehingga pertanyaan "apakah host masih
   menanyakan sesi ini?" bisa dijawab.

> ### Catatan untuk pembaca yang hanya punya 2 menit
>
> Angka 1,96 detik itu bukan satu file yang lambat dibaca. Itu 5.343 file yang
> dibaca dan di-hash karena satu sesi ditanyakan. Panggilan yang sama untuk log
> berformat terbaru hanya 39,7 ms. Selisihnya bukan disk, tapi cabang kode.

---

## 2. Tabel evidence

### 2.1 Angka yang diukur ulang (Label: `[OBSERVED-VERIFIKASI]`)

| Pengukuran | Angka | Sumber |
| --- | --- | --- |
| `stat(id)` id dikenal, log `session.v4.jsonl.zstd` (1.339 sesi, 25%) | min 30,4 ms, median **39,7 ms**, max 67,1 ms | `tools/measure-stat-cost.mjs` |
| `stat(id)` id dikenal, log `session.jsonl.zstd` generasi-0 (4.004 sesi, 75%) | min 1,69 detik, median **1,96 detik**, max 3,00 detik | idem |
| `stat(id)` id TIDAK dikenal | min 31,9 ms, median **46,4 ms**, max 77,3 ms | idem |
| Scan `list()` penuh | 9,7 / 10,4 / 12,4 detik (run committed tool) | idem |
| Panggilan `historicalCorpusRevision()` per `stat()` | 12/12 id generasi-0, 0/12 generasi-4, 0/20 id tak dikenal | `tools/measure-stat-cost-versioned.mjs` (meng-override metodenya untuk menghitung) |
| Biaya `stat()` saat project dir dikunci 1 dan store membesar | 5 log 4,5 ms; 50 log 19,3 ms; 100 log 33,0 ms; 200 log 72,5 ms; 400 log 152,0 ms, yaitu **0,37 ms per log**, sementara `stat()` untuk id tak dikenal tetap datar di ~0,87 ms | `tools/measure-stat-cost-versioned.mjs` |
| Skala terhadap jumlah direktori project | linear, ~0,60 ms/dir (id dikenal), ~0,56 ms/dir (id tak dikenal) | `tools/measure-stat-cost.mjs` (root sintetis 1 sampai 128 direktori) |
| Jumlah direktori project di korpus ini | 65 | idem |
| Sebaran 10 dispose generasi-0 sekaligus | 7,35 detik wall, **0 byte dibaca dari device** | `tools/measure-dispose-burst.mjs` |
| Kontensi I/O lain saat burst berjalan | control baca 64 MiB dengan page cache sudah hangat: 248-341 ms sendiri, **1.448 ms** saat burst berjalan (sekitar 4-6 kali, stabil di 4,26 / 4,83 / 5,55 pada tiga run) | idem |

### 2.2 Yang perlu dibedakan

Id **tak dikenal** itu murah (46 ms) karena `stat()` keluar lebih dulu sebelum
hash korpus dihitung. Jadi tidak semua `stat()` mahal, dan yang mahal adalah
sesi yang log fisikalnya masih generasi-0.

---

## 3. Mekanisme kode

Semua nomor baris di bawah menunjuk FILE SUMBER
`packages/session/session-persistence-jsonl/src/index.ts` dan
`.../src/storage.ts`. Build `lib/index.js` punya nomor baris yang berbeda,
jadi kalau Anda ikut mengutip, ambil dari sumbernya.

### 3.1 `stat()` meng-hash korpus penuh untuk log generasi-0

1. `stat(id)` (`index.ts:438`) mencari log sesi lewat `findLog(id, signal)`
   (`index.ts:3473`).
2. `findLog` menelusuri **setiap** direktori project tanpa keluar lebih awal
   (`index.ts:3475`), jadi biayanya linear terhadap jumlah project
   (~0,60 ms/dir).
3. Setelah log ditemukan, `stat()` menghitung revisi (`index.ts:455`):
   ```js
   revision: selected.sourceVersion < SESSION_FORMAT_VERSION
     ? SessionPersistenceRevision(`${fileRevision(identity)}:${await this.historicalCorpusRevision(options?.signal)}`)
     : fileRevision(identity),
   ```
4. `historicalCorpusRevision()` (`index.ts:1104`) memanggil `listGenerations()`
   untuk mendapatkan seluruh path log generasi, meng-`stat()` setiap path
   (`index.ts:1111`), lalu meng-`hash` pasangan path dan revisi dengan SHA-256
   (`index.ts:1106` sampai `:1119`).
5. `list()` (`index.ts:476`) memanggil fungsi yang sama, tapi **sekali per scan**
   (`index.ts:486`), bukan sekali per sesi. Itu sebabnya `list()` yang mahal
   juga, tapi tidak berlipat.

**Kenapa ini mahal untuk `stat()` dan tidak untuk `list()`:** `list()` memang
harus membaca seluruh korpus, jadi hash korpus adalah bagian dari pekerjaannya.
`stat()` tidak perlu itu untuk menjawab satu sesi, kecuali kalau semantik revisi
generasi-0 memang menuntutnya.

### 3.2 `stat()` menjawab dari tracker in-memory, jadi pertanyaan saat dispose tidak bisa dijawab

1. `stat()` membaca tracker in-memory lebih dulu (`index.ts:445`):
   ```js
   const pending = this.tracker.pendingOf(id)
   if (pending !== undefined) {
     return { header: pending.header, revision: pending.revision }
   }
   ```
   Tracker itu hanya berisi sesi yang sudah dibuat tapi belum pernah ditulis ke
   disk, dan `pendingOf` menjawab tanpa menyentuh disk sama sekali.
2. Entri tracker dihapus saat handle tulis ditutup tanpa materialisasi
   (`storage.ts:499` sampai `:501`, dipanggil dari `releaseHandle` pada
   `storage.ts:256`), dan `releaseHandle` baru jalan **setelah**
   `await this.lease?.release()` (`storage.ts:251`).
3. Backend menutup handle itu di listener `session/disposed`-nya sendiri dan
   **tidak** menunggu (`storage.ts:609` sampai `:617`), dan host juga tidak
   menunggu listener mana pun (`packages/core/session/src/index.ts:403`).

Akibatnya, ketika pemanggil menanyakan `stat(id)` di event `session/disposed`,
tracker masih memegang sesinya, jadi jawabannya "snapshot ada", bukan "tidak
ada". Pemanggil tidak bisa membedakan "host masih menanyakannya" dari "sudah
hilang". Dan `list()` host membaca tracker yang sama (`index.ts:504`), jadi pada
saat itu `list()` dan `stat()` tidak akan pernah berbeda: pemanggil yang
mempertahankan barisnya sendiri sedang berjalan di antara dua jawaban host.

---

## 4. Dampak

- Plugin `dsh-session-readcache` memakai `stat(id)` untuk memutuskan satu baris
  di daftar sesi ketika `session/disposed` datang. Semula plugin ini membayar
  ~1,96 detik per dispose untuk sesi generasi-0. Plugin sekarang tidak
  menanyakan itu untuk sesi yang sudah punya artifact di disk (baris bertanda
  `sizeBytes`), karena artifact-nya bertahan setelah sesi dilepas, jadi host
  tetap menanyakannya dan jawabannya sudah pasti "ada". Pertanyaan yang
  tersisa hanya untuk sesi yang belum pernah ditulis, dan itu murah.
- Pemanggil lain dari `stat()` pada log generasi-0 membayar harga yang sama, dan
  tidak ada yang tahu apakah host ini bisa memakai ulang hash itu.
- Pertanyaan "apakah host masih menanyakan sesi ini?" tidak bisa dijawab pada
  saat dispose, seperti di bagian 3.2. Plugin menunggu penyegaran di belakang
  untuk jawaban itu, jadi barisnya bertahan sampai penyegaran selesai, bukan
  langsung hilang.
- Host tidak menunggu listener `session/disposed`
  (`packages/core/session/src/index.ts:403`), jadi biayanya tidak di jalur
  pemanggil. Tapi burst tetap menekan I/O lain DI DALAM proses: sepuluh dispose
  generasi-0 yang jalan bersamaan tidak memindahkan satu byte pun dari device
  (0 read, karena `historicalCorpusRevision()` hanya meng-`stat()` path dan tidak
  pernah membuka log), namun control baca 64 MiB di device yang sama naik dari
  248-341 ms jadi 1.448 ms, jadi sekitar 4-6 kali lebih lambat. Jadi risikonya ada di lock
  VFS, page cache dan CPU host, bukan di bandwidth device.

---

## 5. Usulan

### 5.1 Revisi korpus di jalur `stat()`

**Pertanyaan untuk host:** apakah revisi korpus itu perlu di jalur `stat()`?

Kalau perlu, tiga arah yang terlihat, dari yang paling kecil:

1. **Pakai ulang satu hash per instance, di-invalidate saat ada tulis.** Host
   sudah tahu setiap write dan delete yang ia lakukan, jadi invalidasi bisa
   dibuat tepat. Konsekuensinya: `stat()` untuk log generasi-0 berubah dari
   O(korpus) jadi O(1) setelah panggilan pertama.
2. **Cache dengan TTL pendek.** Lebih mudah, tapi revisi bisa basi sampai TTL.
   Kalau ada konsumen yang memakai revisi `stat()` sebagai token perubahan, ini
   mengubah maknanya, jadi harus ada keputusan eksplisit.
3. **Hanya korpus yang berubah.** Kalau hashing seluruh korpus itu bermakna
   "korpus ini berubah" dan bukan "sesi ini berubah", maka `stat()` mungkin bisa
   memakai token yang lebih murah untuk kasus satu-sesi.

### 5.2 Keberadaan artifact yang mengabaikan tracker

**Pertanyaan untuk host:** adakah cara memeriksa "apakah artifact sesi ini
benar-benar ada di disk" yang mengabaikan tracker in-memory? Misalnya
`hasArtifact(id)`, atau `stat(id, { source: 'disk' })`.

Tanpa itu, pertanyaan "apakah host masih menanyakan sesi ini?" tidak bisa
dijawab pada saat dispose, karena host menjawab dari tracker yang masih
menanyakannya (bagian 3.2). Plugin `dsh-session-readcache` akan memakainya
begitu ada; sampai itu, barisnya bertahan sampai penyegaran di belakang
selesai, yang batasnya sama dengan sebelum C1.

**Fix-nya tidak menambah biaya apa pun.** Pemeriksaan kebenaran disk yang
mengabaikan tracker sudah diukur di store nyata: `findLog(id)` tanpa tracker
biaya min 30,5 ms, median 47,7 ms, max 67,2 ms atas 20 panggilan, yaitu kelas
yang sama dengan `stat()` yang sudah dibayar plugin sekarang. Bentuk jawaban
yang sudah ada juga cukup: ada `sizeBytes` berarti termaterialisasi, tidak ada
berarti masih dilacak, `undefined` berarti hilang. Jadi tidak ada signal baru
yang perlu ditambahkan, hanya satu pemeriksaan yang mengabaikan tracker.

Yang **tidak** kami usulkan: plugin mengubah perilakunya untuk menyembunyikan
biaya ini, atau menebak waktu saat handle tulis ditutup. Biayanya milik API
host, dan menyelesaikannya di sisi pemanggil berarti setiap pemanggil
menanggung workaround yang sama, dan yang menebak waktu membuat janji
"staleness berbatas" plugin berubah jadi "staleness kira-kira".

---

## 6. Yang harus diuji kalau fix diterapkan

- `stat(id)` untuk log generasi-0 dan generasi-4 tetap mengembalikan revisi
  yang **berbeda** setelah log itu berubah, dan tetap sama setelah log lain
  berubah, kalau mem Tokens korpus memang masih bagian dari maknanya.
- `list()` dan `stat()` tidak berbeda pendapat soal revisi log yang sama.
- `delete()` dan write memvalidasi cache dengan benar, sehingga revisi basi
  tidak pernah lolos.
- Pemanggil yang memakai `stat()` sebagai token perubahan (bacaan host
  `observeSession` dan `sessionQuery`) tetap melihat perubahan.
- Kalau ada `hasArtifact(id)`: hasilnya harus sama dengan "ada artifact di
  disk", termasuk untuk sesi yang sedang dilepas dan handle tulisnya belum
  ditutup. Kalau berbeda, pemanggil akan salah menyimpulkan.

---

## 7. Batasan jujur

- **Perilaku dengan page cache dingin: belum diketahui.** Mengosongkan page
  cache butuh akses root dan akan mengganggu host yang sedang jalan, jadi angka
  itu tidak diukur.
- **Perilaku pada korpus 10 kali lebih besar: belum diketahui.** Hash korpus
  linear terhadap jumlah log, jadi diperkirakan ikut naik, tapi itu
  ekstrapolasi, bukan pengukuran.
- **Apakah `delete()` pada host ikut menerbitkan `session/disposed`: sudah
  dipastikan tidak.** `session/disposed` terbit dari tepat satu tempat, yaitu
  detach pada store sesi (`packages/core/session/src/index.ts:1130` sampai
  `:1196`), dan API `delete()` pada persistence tidak menerbitkan apa pun. Jadi
  plugin tidak pernah diberi tahu soal delete, dan barisnya bertahan sampai
  refresh berikutnya.
- **Jalur `delete()` memang melepas tracker lebih dulu, dan itu satu-satunya
  jalur di mana tracker hilang sebelum plugin sempat bertanya.** Terukur: sesi
  yang masih dilacak menjawab `snapshot`, dan sesi yang sama setelah
  `forgetSession()` menjawab `undefined`. `forgetSession()` dipanggil
  `delete()` di `lib/index.js:2703`, dan `delete()` tidak menerbitkan
  `session/disposed`, jadi plugin tidak pernah diberi tahu. Praktisnya: jalur
  remove tidak pernah terpakai di host ini, dan barisnya bertahan sampai
  refresh berikutnya.
- **instance `SessionPersistence` yang hidup mungkin dikonfigurasi berbeda.**
  Store yang diukur memakai `compression: zstd`, sama dengan default backend.
- Angka di bagian 2.1 berlaku untuk instance yang sama dengan yang dipakai
  plugin di host hidup, karena `stat()` tidak memakai cache log per sesi.

---

## 8. Ringkasan klaim

| Klaim | Label | Sumber |
| --- | --- | --- |
| `stat(id)` meng-hash korpus penuh untuk log generasi-0 | `[OBSERVED-VERIFIKASI]` | `src/index.ts:455` memanggil `historicalCorpusRevision()` (`:1104`) yang meng-`stat()` setiap log (`:1111`) |
| 1,96 detik median per panggilan untuk generasi-0 | `[OBSERVED-VERIFIKASI]` | `tools/measure-stat-cost.mjs` |
| 39,7 ms median untuk generasi-4 dan untuk id tak dikenal | `[OBSERVED-VERIFIKASI]` | idem |
| 12/12 id generasi-0 memicu hash korpus, 0/12 generasi-4 | `[OBSERVED-VERIFIKASI]` | `tools/measure-stat-cost-versioned.mjs` |
| `stat()` menjawab dari tracker in-memory sebelum menyentuh disk | `[OBSERVED-VERIFIKASI]` | `src/index.ts:445`, `src/storage.ts:499` |
| Entri tracker baru hilang setelah handle tulis ditutup dan lease dilepas | `[OBSERVED-VERIFIKASI]` | `src/storage.ts:251` dan `:256` |
| Host tidak menunggu listener `session/disposed` | `[OBSERVED-VERIFIKASI]` | `packages/core/session/src/index.ts:403` |
| Burst dispose tidak membaca byte dari device, tapi memperlambat I/O lain sekitar 4-6 kali | `[OBSERVED-VERIFIKASI]` | `tools/measure-dispose-burst.mjs` |
| Page cache dingin, korpus 10x lebih besar, dan perilaku `delete()` | `UNKNOWN` atau sudah dipastikan | lihat bagian 7 |

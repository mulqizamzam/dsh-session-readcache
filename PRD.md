# PRD: dsh-session-readcache

Status: aktif. Versi plugin `0.1.0`. Terakhir diperbarui 2026-10-21.

Dokumen ini menyatakan apa yang harus benar dari plugin ini, bagaimana
buktinya, dan mana yang belum selesai. README.md adalah cara pakainya; PRD ini
adalah syaratnya. Angka di sini selalu menyebut sumbernya, dan angka yang tidak
diukur ulang di host ini diberi label sebagai rekaman repo.

## 1. Ringkasan

`dsh-session-readcache` adalah plugin DeepSeek Harness yang menyimpan hasil
`sessionPersistence.list()` di memori, supaya membuka daftar sesi di GUI tidak
menunggu pemindaian direktori setiap kali.

Masalahnya nyata dan terukur di host ini. Scan `list()` host yang sesungguhnya
atas korpus 5.343 log memakan median 12,9 detik, dari tiga scan berturut-turut
10,3 / 12,9 / 14,4 detik (`tools/measure-stat-cost.mjs`, 2026-10-21). Setelah
di-cache, balasan yang sama sampai dalam 1,4 milidetik (angka rekaman
2026-10-20 atas 4.016 header).

Pengguna yang utama adalah orang yang menjalankan DSH lama-lama sampai folder
sesinya berisi ribuan log, lalu daftar sesi jadi terasa seperti macet.

## 2. Masalah

| Gejala | Angka | Sumber |
| --- | --- | --- |
| `list()` memindai seluruh direktori sesi dan mengurai header tiap log | 2,15-2,62 detik, empat run, diukur lewat scan pengganti, bukan `list()` host yang sesungguhnya. Tidak direproduksi ulang pada 2026-10-21 | `tools/measure-session-scan.mjs` |
| Pemindaian yang sama saat page cache host kosong | 77,7 detik. Tidak terukur ulang pada 2026-10-21: page cache tidak bisa dikosongkan tanpa hak root tanpa mengganggu host yang sedang jalan, jadi nilainya tidak diketahui, bukan nol | idem |
| Scan `list()` host yang sesungguhnya, korpus 5.343 log | 10,3 / 12,9 / 14,4 detik (tiga scan berturut-turut), median 12,9 detik. Antar-run scan ini berada di 7,7 sampai 17,6 detik (tujuh run), jadi penyebut rasio bergerak jauh | `tools/measure-stat-cost.mjs` |
| `stat()` untuk log generasi-4, 25% sesi | median 40,4 ms, maksimum 48,2 ms. Antar-run mediannya 29 sampai 40 ms | idem |
| `stat()` untuk log generasi-0, 75% sesi | median 1,96 detik, maksimum 3,30 detik. Antar-run mediannya 1,4 sampai 2,0 detik | idem |
| Biaya latar satu `session/disposed` sebelum aturan dipersempit | median 2,28 detik, di luar jalur pemanggil | idem |
| Biaya latar satu `session/disposed` sesudah aturan dipersempit | nol untuk sesi yang sudah punya artifact di disk; median 40,3 ms untuk sesi yang belum pernah ditulis | idem |
| Balasan dari memo untuk 4.016 header | 1,4-3,8 ms | `tools/measure-session-scan.mjs` |
| `list()` setelah satu `session/disposed` | 2,64 detik sebelum fix, 4 ms sesudahnya | `tools/repro-dispose-stall-real.mjs` |
| Serialisasi snapshot 4.016 header | 2,9-4,0 ms, sebelumnya di jalur respons pemanggil | `tools/probe-snapshot-response-path.mjs` |
| Korpus yang diukur | 4.016 log, 2,3 GB (2026-10-20); 5.343 log (2026-10-21) | `du -sh /home/administrator/agent-workspace/.dsh/sessions` |
| Seed boot saat restart | Ditolak: baris berumur 56 menit, jendela 10 menit, jadi reply pertama membayar scan penuh | `curl http://127.0.0.1:13080/plugin/session-readcache/metrics` (catatan `snapshot too old (3357s)`) |

Yang membuat masalah ini tidak bisa diselesaikan di host: `list()` adalah
method baca yang dipanggil dua pemanggil in-tree, `session-query`
`listPersisted` dan ACP `sessionList`, keduanya butuh daftar lengkap setiap
kali. Plugin ini tidak mengubah kode host sama sekali.

## 3. Solusi

Empat mekanisme, semuanya di `lib/index.js`:

1. **Memo ber-TTL.** Hasil scan terakhir disimpan di memori. Selama TTL
   (`listTtlMs`, default 750 ms), panggilan dilayani dari sana.
2. **Penggabungan permintaan.** Panggilan yang berbarengan saat tidak ada memo
   hangat berbagi satu scan, bukan satu scan masing-masing.
3. **Jendela stale.** Setelah TTL habis, hasil lama dikembalikan seketika
   (`listMaxStaleMs`, default 30 detik) sementara satu scan berjalan di
   belakang. Ini yang membuat balasan tetap milidetik saat pemindaian butuh
   detik-detik.
4. **Snapshot SQLite.** Hasil scan terakhir ditulis ke satu baris SQLite, supaya
   proses yang baru start menjawab panggilan pertamanya tanpa memindai.

## 4. Persyaratan fungsional

| ID | Persyaratan | Dibuktikan oleh |
| --- | --- | --- |
| FR-1 | `list()` dilayani dari memo selama TTL, dengan satu scan untuk banyak panggilan | `list: a second call inside the TTL is served from the memo` |
| FR-2 | Panggilan yang berbarengan berbagi satu scan | `list: concurrent calls share one scan` |
| FR-3 | Setelah TTL habis tapi masih di dalam jendela stale, pemanggil dilayani seketika dan scan berjalan di belakang | `list: past the TTL but inside the stale window the caller is served immediately` |
| FR-4 | Setelah jendela stale habis, pemanggil menunggu scan segar | `list: past the stale window the caller waits for a fresh scan` |
| FR-5 | `session/disposed` tidak memaksa pemanggil berikutnya menunggu scan; memo ditandai basi dan disegarkan di belakang | `lifecycle: a disposed session must not make the next list() wait for a scan` |
| FR-6 | Memo yang basi tidak pernah disajikan sebagai hit segar | `lifecycle: a disposed session must not make the next list() wait for a scan` |
| FR-7 | Baris snapshot hanya disajikan kalau setiap elemennya berbentuk snapshot sesi dan umurnya di bawah `snapshotMaxAgeMs` | `snapshot: a young row of session snapshots seeds the first reply without scanning`, `snapshot: a row of flat headers is refused, not served (the live seeding failure)`, `snapshot: a row older than snapshotMaxAgeMs is not served` |
| FR-8 | Serialisasi snapshot tidak pernah menahan reply pemanggil | `snapshot: the serialization runs after the caller already has its reply` |
| FR-9 | Setiap pemanggil menerima salinan sendiri, jadi perubahan header oleh satu pemanggil tidak mengotori memo atau pemanggil lain | `list: the memo hands out copies; caller mutation cannot poison it` |
| FR-10 | Kunci yang bisa mencapai prototipe dibuang dari snapshot dan header-nya | `list: prototype-reaching keys are stripped from the snapshot and its header` |
| FR-11 | Pemanggil yang sudah dibatalkan tidak dilayani dari memo dan tidak dihitung | `list: a pre-aborted caller is not counted (the host never scans)` |
| FR-12 | Opsi pemanggil diteruskan apa adanya ke scan host | `list: the caller options bag is forwarded untouched to the host scan` |
| FR-13 | Konfigurasi di luar domain jatuh ke default dan nama kuncinya disebut di log mount | `config: invalid values fall back to defaults and the route reports them` |
| FR-14 | `enabled: false` mematikan plugin tanpa meninggalkan route | `mount: disabled by config leaves no routes` |
| FR-15 | Service tanpa `list()` tetap mount dalam mode `inert` dan tetap melaporkan metrik | `mount: a persistence without list() mounts inert but still exposes metrics` |
| FR-16 | Pada `session/disposed`, plugin bertanya ke host apakah artifact sesi itu masih ada di disk, dan mencabut baris itu kalau host menjawab tidak ada artifact-nya. Baris yang sudah punya artifact dipertahankan tanpa menanyakan host, dan `stat` yang menolak juga mempertahankan baris | `dispose: the plugin removes the row when the host says the session is gone, and the caller is served from memory`, `dispose: a session the host still knows keeps its row`, `dispose: a materialized row is kept without asking the host`, `dispose: a stat() that rejects keeps the row and never rejects out of the listener`, `dispose: a persistence without stat() keeps the row and the listener does not throw` |

## 5. Persyaratan non-fungsional

| ID | Persyaratan | Ambang terukur |
| --- | --- | --- |
| NFR-1 | Balasan dari memo tidak boleh lebih lambat dari pemindaian yang dihindarinya | 1,4-3,8 ms untuk 4.016 header, terhadap median scan 12,9 detik atas 5.343 log |
| NFR-2 | Plugin bersifat advisory: kegagalan di lapisan cache selalu jatuh ke method asli | Tidak ada exception yang keluar dari `list()`; setiap jalur tulis snapshot di-`try`/`catch` |
| NFR-3 | Plugin hanya membungkus method baca | Hanya `list` yang di-`defineProperty`; `load`, `prepare`, dan penulisan tidak pernah dibungkus |
| NFR-4 | Plugin tidak menulis ke log sesi | Nol jalur tulis yang disentuh |
| NFR-5 | Kegagalan memuat modul native tidak mematikan boot | Memo tetap jalan tanpa persistensi snapshot; alasannya muncul di `snapshot.notes` |
| NFR-6 | Mount tidak boleh mati diam-diam | Baris `[session-readcache] mounted (...)` selalu tercetak; mode `inert` dilaporkan di metrik |
| NFR-7 | Jam yang dipakai TTL dan jendela stale adalah jam monotonik | `lib/index.js:44-47` |

## 6. Batas kesegaran

Kesegaran adalah trade-off yang disengaja, jadi batasnya ditulis eksplisit:

| Keadaan | Umur paling tua yang masih dilayani |
| --- | --- |
| Setelah scan nyata terakhir | `listMaxStaleMs` (30 detik dengan default) |
| Setelah seed dari snapshot saat boot | `snapshotMaxAgeMs + listTtlMs + listMaxStaleMs` (24 jam + 750 ms + 30 detik dengan default). Terukur: seed ditolak saat restart dengan jendela 10 menit karena snapshot berumur 56 menit; jendela dinaikkan ke 24 jam |
| Setelah `session/disposed`, untuk baris sesi yang dibuang | Sampai penyegaran di belakang selesai pada host yang menjawab dari tracker, sama seperti sebelum C1, karena pada event dispose tracker masih memegang sesinya. Baris hilang lebih awal kalau host menjawab "tidak ada artifact-nya", dan itu yang terjadi pada host yang menjawab dari disk |
| Setelah `session/disposed`, untuk sisa isi memo | `listMaxStaleMs` (30 detik dengan default), sampai penyegaran di belakang selesai |

`session/disposed` tidak lagi membuang memo; memo ditandai basi. Plugin hanya
menanyakan host untuk baris sesi yang belum pernah ditulis ke disk, dan
mencabut baris itu kalau host menjawab sesi sudah tidak ada. Baris yang sudah
punya artifact dipertahankan tanpa menanyakan host, karena `list()` milik host
masih menyebut sesi itu.

Yang berubah sejak host `0.2.0-rc.2` menghapus `inspect`: jalur `list()` hanya
mengembalikan header sesi, dan header (`id`, `createdAt`, `cwd`, `version`,
`isSeeded`) tidak berubah saat flush terakhir mendarat.

Pada event dispose, plugin bertanya ke host apakah ARTIFAK sesi itu masih ada
di disk, lewat `stat(id, { source: 'disk' })`. Host yang mendukung opsi itu
menjawab dari artifact durable, bukan dari tracker in-memory, jadi sesi yang
dibuang tanpa pernah ditulis langsung hilang dari memo. Host yang mengabaikan
opsi itu menjawab dari tracker, dan tracker masih memegang sesi sampai handle
tulis ditutup; di sana barisnya bertahan sampai penyegaran di belakang selesai,
seperti sebelum C1. Jalur `delete()` juga tidak memberi tahu plugin:
`delete()` tidak mempublikasikan `session/disposed`, jadi baris yang dihapus dari
store juga bertahan di memo sampai penyegaran berikutnya. Karena
itu `disposeRowsRemoved` membaca 0 pada host ini. Itu informasi, bukan kegagalan.

Jawaban `stat()` datang asynchronous, dan memo tidak pernah dibuang selama
jawabannya belum tiba. Kalau `stat` menolak atau `target.stat` bukan fungsi,
baris dipertahankan karena jawaban "tidak ada artifact-nya" belum terbukti; baris itu
hilang saat penyegaran di belakang selesai, dan penyegaran itu sudah dijadwalkan
oleh dispose yang sama.

## 7. Antarmuka

**Konfigurasi** (`cordis.patch.yml`, semua kunci opsional):

| Kunci | Default | Arti |
| --- | --- | --- |
| `enabled` | `true` | `false` mematikan plugin |
| `listTtlMs` | `750` | Umur memo yang masih dianggap segar |
| `listMaxStaleMs` | `30000` | Jendela tambahan setelah TTL habis |
| `snapshotMaxAgeMs` | `86400000` | Umur snapshot yang boleh dipakai untuk boot. 24 jam, bukan 10 menit: baris hanya ditulis ulang setelah scan, jadi jeda "idle lalu restart" sering lebih panjang dari jendela pendek |
| `snapshotPath` | turunan | Lokasi file SQLite snapshot |

**Endpoint HTTP** (dipasang di web server host):

- `GET /plugin/session-readcache/metrics` mengembalikan penghitung, konfigurasi efektif, dan alasan kegagalan snapshot.
- `POST /plugin/session-readcache/purge` membuang memo. Metode lain dijawab `405`.

## 8. Di luar lingkup

- **Tidak ada jalur tulis.** Penulisan sesi, `load`, `prepare`, dan perbaikan data tidak disentuh.
- **Tidak ada cache per sesi.** Jalur baca satu sesi milik host: `sessionQuery.observeSession` sudah membawa cache sendiri ber-key revisi `stat`.
- **Tidak ada proses sendiri.** Plugin tidak punya server, tidak punya antrean, tidak butuh build.
- **Tidak ada migrasi, seed, atau init.** Baris snapshot ditulis plugin sendiri setelah scan.

## 9. Risiko

| Risiko | Bukti | Mitigasi |
| --- | --- | --- |
| Memakai modul native yang gagal dimuat | `SECURITY-AUDIT.md` | Jalur snapshot di-`try`/`catch`; memo tetap jalan, alasannya di `snapshot.notes` |
| Baris snapshot rusak atau ditulis build lain | Loader menolak baris yang bukan snapshot sesi, yang terlalu besar, yang versinya beda, atau yang stempelnya di masa depan | Empat test menolak bentuk itu, `SNAPSHOT_MAX_BYTES` membatasi ukuran baris |
| Kunci prototipe masuk ke objek pemanggil | `copy()` membangun ulang snapshot dan header-nya key demi key | `list: prototype-reaching keys are stripped from the snapshot and its header` |
| Endpoint purge dipanggil tanpa sengaja | `GET` ditolak, `POST` hanya | Route menjawab `405` untuk metode lain |
| Salinan per pemanggil membuat balasan O(jumlah sesi) | 1,4-3,8 ms untuk 4.016 header | Biaya di bawah 0,1 % dari pemindaian yang dihindarinya (3,8 ms terhadap median scan 12,9 detik). Tidak diubah karena kontrak "pemanggil tidak bisa mengotori memo" |

## 10. Kriteria penerimaan

- [ ] `node tests/logic.mjs` → `37/37 pass`, exit 0
- [ ] `node tests/runtime-smoke.mjs` → `STATUS: PROVEN`, exit 0 (host terisolasi, bukan host yang sedang jalan)
- [ ] Baris `[session-readcache] mounted (mode=list-memo, ...)` muncul di log boot host
- [ ] `GET /plugin/session-readcache/metrics` menjawab `200` dengan JSON, dan `mode` bernilai `list-memo`
- [ ] `list.hits` atau `list.staleServed` naik setelah daftar sesi dibuka berulang
- [ ] `snapshot.saves` naik setelah scan selesai, dan `snapshot.failures` tetap `0`
- [ ] Setelah restart dengan baris snapshot yang lebih muda dari `snapshotMaxAgeMs`, `snapshot.seeded` bernilai `true` dan panggilan pertama dilayani tanpa scan

## 11. Verifikasi

| Yang diklaim | Perintah | Keluaran yang diharapkan |
| --- | --- | --- |
| Kontrak unit | `node tests/logic.mjs` | `37/37 pass` |
| Bukti lewat batas host | `node tests/runtime-smoke.mjs` | `STATUS: PROVEN` |
| Balasan dari memo tidak menunggu pemindaian | `node tools/repro-dispose-stall.mjs` | `PASS`, reply 0,1 ms |
| Idem pada korpus asli | `node --import <tsx> tools/repro-dispose-stall-real.mjs` | `PASS`, reply 4 ms |
| Memo tetap converge ke kebenaran host | `node tools/verify-dispose-convergence.mjs` | `8/8 checks pass` |
| Serialisasi tidak di jalur respons | `node tools/probe-snapshot-response-path.mjs` | `scan-resolved -> caller-resumed -> stringify` |
| Memo bertahan lintas dispose di host hidup | `curl http://127.0.0.1:13080/plugin/session-readcache/metrics` | `memo.warm:true` sementara `disposedInvalidations:6` |

Skrip di `artifacts/` tidak ikut ter-commit (folder itu di-ignore), jadi baris
terakhir bukan perintah yang bisa dijalankan dari repo yang dikloning.

## 12. Keputusan terbuka

1. **Kunci metrik berubah.** `lifecycle.disposedDrops` diganti
   `lifecycle.disposedInvalidations`, karena memo tidak lagi dibuang. Key ketiga,
   `lifecycle.disposeRowsRemoved`, ditambahkan 2026-10-21: ia menghitung
   dispose yang benar-benar mencabut satu baris dari memo. Di host ini
   `disposeRowsRemoved` membaca 0 pada host yang menjawab dari tracker; angka nol
   itu informasi, bukan kegagalan. Kalau ada konsumen luar endpoint metrik, kunci lama bisa
   dikembalikan sebagai alias satu rilis.
2. **Opsi inert. SUDAH DIPUTUSKAN 2026-10-21: C1, dihapus.** `maxEntries` dan
   `maxTotalEvents` tidak lagi melakukan apa-apa sejak 2026-10-10 (sisa cache
   `inspect` yang dihapus bersama host `0.2.0-rc.2`). Keduanya dihapus dari
   `DEFAULTS`, dari validasi config, dari metrics, dari `cordis.patch.yml`, dan
   dari test. Alasannya: metrics berhenti melaporkan angka yang tidak pernah
   dipakai, jadi tidak ada yang salah baca. Trade-off yang dicatat: bentuk
   `config` di endpoint metrics berubah, dan patch lama yang masih menyebut
   kedua kunci itu diabaikan tanpa efek. Varian C2 (tandai sebagai `inert` di
   metrics) tidak diambil karena menambah field baru tanpa menghapus apa pun.
3. **Salinan per pemanggil.** Kontrak "satu pemanggil tidak bisa mengotori
   pemanggil lain" membuat setiap balasan O(jumlah sesi). Melepas kontrak itu
   membuat balasan O(1), tapi mengubah perilaku yang dijanjikan README.
4. **Batas baris yang dibuang. SUDAH DIPUTUSKAN 2026-10-21: C1, tanyakan host
   dan cabut baris kalau host bilang sesi sudah tidak ada.** `session/disposed`
   menandai memo basi, lalu
   `target.stat(id)` milik host dipakai untuk memutuskan baris mana yang boleh
   dicabut. Tapi host hanya ditanya untuk baris yang bisa saja tidak lagi disebut
   `list()`, yaitu baris sesi yang hidup tapi belum pernah ditulis ke disk. Baris
   yang sudah punya artifact di disk, yaitu baris snapshot host yang membawa
   `sizeBytes`, dipertahankan tanpa menanyakan host: dispose hanya melepaskan
   sesi, bukan menghapus lognya, jadi artifact itu bertahan lebih lama dari
   sesinya, `list()` host masih menyebut sesi itu, dan baris memo-nya memang
   benar. Aturan lengkapnya: `stat` mengembalikan snapshot -> baris
   dipertahankan; `stat` mengembalikan `undefined` -> baris dicabut dari memo,
   karena `list()` host juga tidak akan menyebutnya; `stat` menolak atau
   `target.stat` bukan fungsi -> baris dipertahankan, karena ketiadaan artifact
   belum terbukti.
   Alasannya: `list()` host berbasis disk, jadi sesi yang tidak pernah ditulis
   ke disk adalah satu-satunya yang akan hilang dari jawaban host, dan sesi
   yang lognya masih ada di disk masih disebut host sehingga harus tetap ada di
   memo. Persempitan itu juga yang membuat plugin tidak masuk kelas mahal:
   `stat()` pada log generasi lama menghitung `historicalCorpusRevision()` yang
   menghash SELURUH korpus, dengan median 1,96 detik di host ini, dan baris
   seperti itu justru tidak pernah ditanyakan, karena baris itu selalu punya
   artifact. Yang ditanyakan hanya jalur murah, dengan median 40,3 ms (sumber
   di bagian 2).
   Batasnya: jawaban `stat()` datang asynchronous, jadi pemanggil yang datang
   sebelum jawabannya tiba masih bisa melihat barisnya; di host ini jawabannya
   datang dalam puluhan milidetik, dan memo tidak pernah dibuang selama
   jawabannya belum tiba. Sisa memo tetap basi sampai `listMaxStaleMs` (30 detik
   dengan default), dan pemanggil berikutnya dilayani dari memori sementara
   penyegaran berjalan di belakang.
   Pada event dispose, plugin bertanya ke host apakah ARTIFAK sesi itu masih ada
di disk, lewat `stat(id, { source: 'disk' })`. Host yang mendukung opsi itu
menjawab dari artifact durable, bukan dari tracker in-memory, jadi sesi yang
dibuang tanpa pernah ditulis langsung hilang dari memo. Host yang mengabaikan
opsi itu menjawab dari tracker, dan tracker masih memegang sesi sampai handle
tulis ditutup; di sana barisnya bertahan sampai penyegaran di belakang selesai,
seperti sebelum C1. Jalur `delete()` juga tidak memberi tahu plugin:
`delete()` tidak mempublikasikan `session/disposed`, jadi baris yang dihapus dari
store juga bertahan di memo sampai penyegaran berikutnya. Karena itu `disposeRowsRemoved` membaca 0 pada host ini. Itu
   informasi, bukan kegagalan.
   Trade-off yang dicatat: jalur event kini memanggil satu method host lagi,
   jadi plugin bergantung pada `SessionPersistence.stat` yang ada di interface
   host (`packages/session/session-persistence/src/index.ts`,
   `abstract stat(id, options?)`). Varian "buang memo sepenuhnya" tidak diambil:
   satu peristiwa satu baris tidak boleh mengubah satu baris jadi satu pemindaian
   direktori penuh (median 12,9 detik di host ini atas korpus 5.343 log, sumber
   di bagian 2, dan alasannya tertulis di kontrak
   `docs/CONTRACT-c1-dispose.md`). Varian "buang baris tanpa bertanya
   ke host" tidak diambil: `list()` host berbasis disk, jadi baris yang
   artifact-nya masih ada tetap disebut host dan membuangnya akan membuat memo
   berbeda dari jawaban host. Batas yang tetap ada: plugin tidak pernah diberi
   tahu tentang sebuah delete, karena API `delete()` milik host tidak
   memancarkan `session/disposed`, jadi log sesi yang dihapus di luar jalur
   dispose tetap di memo sampai refresh berikutnya.
5. **Jendela seed boot. SUDAH DIPUTUSKAN 2026-10-21: C1, jendela 24 jam.**
   `snapshotMaxAgeMs` bawaan 10 menit lebih sempit dari jeda \"idle lalu
   restart\" yang paling sering terjadi. Terukur di host hidup: saat restart,
   snapshot terakhir berumur 56 menit, seed ditolak (`snapshot too old (3357s);
   rescanning`), dan reply pertama membayar scan penuh. Jendelanya dinaikkan ke
   24 jam (`86_400_000`) di `cordis.patch.yml` dan di `DEFAULTS`. Alasannya: satu
   baris config, nol kode dan nol I/O baru, dan isinya cuma daftar sesi yang
   perubahannya lambat. Trade-off yang dicatat: reply pertama sesudah restart
   bisa basi sampai 24 jam. Varian C2 (tulis ulang snapshot secara berkala)
   tidak diambil karena menambah timer dan penulisan 4,7 MB per siklus.

## 13. Prinsip yang tidak boleh dilanggar

- Cache bersifat advisory: setiap kegagalan jatuh ke method asli.
- Set faithfully pada pembatalan: pemanggil yang sudah dibatalkan tidak pernah
  dilayani dari memo dan tidak dihitung.
- Bungkus hanya baca.
- Mount tidak boleh mati diam-diam.
- Klaim harus punya sumber. Angka yang hanya hasil pembacaan kode diberi label
  **Inferred**, angka yang belum diuji diberi label **Perlu dikonfirmasi**.

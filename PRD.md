# PRD: dsh-session-readcache

Status: aktif. Versi plugin `0.1.0`. Terakhir diperbarui 2026-10-20.

Dokumen ini menyatakan apa yang harus benar dari plugin ini, bagaimana
buktinya, dan mana yang belum selesai. README.md adalah cara pakainya; PRD ini
adalah syaratnya. Angka di sini selalu menyebut sumbernya, dan angka yang tidak
diukur ulang di host ini diberi label sebagai rekaman repo.

## 1. Ringkasan

`dsh-session-readcache` adalah plugin DeepSeek Harness yang menyimpan hasil
`sessionPersistence.list()` di memori, supaya membuka daftar sesi di GUI tidak
menunggu pemindaian direktori setiap kali.

Masalahnya nyata dan terukur di host ini: satu pemindaian `list()` atas korpus
4.016 log.session memakan 2,6 detik saat page cache hangat dan 77,7 detik saat
page cache kosong. Setelah di-cache, balasan yang sama sampai dalam 1,4
milidetik.

Pengguna yang utama adalah orang yang menjalankan DSH lama-lama sampai folder
sesinya berisi ribuan log, lalu daftar sesi jadi terasa seperti macet.

## 2. Masalah

| Gejala | Angka | Sumber |
| --- | --- | --- |
| `list()` memindai seluruh direktori sesi dan mengurai header tiap log | 2.150-2.616 ms, empat run | `artifacts/perf/verify-slowscan.mjs` |
| Pemindaian yang sama saat page cache host kosong | 77.680 ms | idem |
| Balasan dari memo untuk 4.016 header | 1,4-3,8 ms | idem |
| `list()` setelah satu `session/disposed` | 2.640 ms sebelum fix, 4 ms sesudahnya | `artifacts/perf/repro-dispose-stall-real.mjs` |
| Serialisasi snapshot 4.016 header | 2,9-4,0 ms, sebelumnya di jalur respons pemanggil | `artifacts/perf/probe-snapshot-response-path.mjs` |
| Korpus yang diukur | 4.016 log, 2,3 GB | `du -sh /home/administrator/agent-workspace/.dsh/sessions` |

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

## 5. Persyaratan non-fungsional

| ID | Persyaratan | Ambang terukur |
| --- | --- | --- |
| NFR-1 | Balasan dari memo tidak boleh lebih lambat dari pemindaian yang dihindarinya | 1,4-3,8 ms untuk 4.016 header, terhadap 2,6-77,7 ms untuk pemindaian |
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
| Setelah seed dari snapshot saat boot | `snapshotMaxAgeMs + listTtlMs + listMaxStaleMs` (10 menit + 750 ms + 30 detik dengan default). Terukur: seed ditolak saat restart karena snapshot berumur 56 menit |
| Setelah `session/disposed` | `listMaxStaleMs`, untuk baris sesi yang dibuang tapi belum pernah ditulis ke disk |

`session/disposed` tidak lagi membuang memo. Baris sesi yang dibuang masih bisa
muncul sampai penyegaran selesai, dan itu satu-satunya tempat di mana memo
berbeda dari jawaban host. Yang berubah sejak host `0.2.0-rc.2` menghapus
`inspect`: jalur `list()` hanya mengembalikan header sesi, dan header
(`id`, `createdAt`, `cwd`, `version`, `isSeeded`) tidak berubah saat flush
terakhir mendarat.

## 7. Antarmuka

**Konfigurasi** (`cordis.patch.yml`, semua kunci opsional):

| Kunci | Default | Arti |
| --- | --- | --- |
| `enabled` | `true` | `false` mematikan plugin |
| `listTtlMs` | `750` | Umur memo yang masih dianggap segar |
| `listMaxStaleMs` | `30000` | Jendela tambahan setelah TTL habis |
| `snapshotMaxAgeMs` | `600000` | Umur snapshot yang boleh dipakai untuk boot |
| `snapshotPath` | turunan | Lokasi file SQLite snapshot |
| `maxEntries` | `24` | Inert sejak 2026-10-10, sisa kapasitas LRU `inspect` yang sudah dihapus. Tetap divalidasi dan dilaporkan |
| `maxTotalEvents` | `250000` | Inert sejak 2026-10-10, sisa anggaran event cache yang sudah dihapus |

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
| Salinan per pemanggil membuat balasan O(jumlah sesi) | 1,4-3,8 ms untuk 4.016 header | Biaya 0,05 % dari pemindaian yang dihindarinya. Tidak diubah karena kontrak "pemanggil tidak bisa mengotori memo" |

## 10. Kriteria penerimaan

- [ ] `node tests/logic.mjs` → `28/28 pass`, exit 0
- [ ] `node tests/runtime-smoke.mjs` → `STATUS: PROVEN`, exit 0 (host terisolasi, bukan host yang sedang jalan)
- [ ] Baris `[session-readcache] mounted (mode=list-memo, ...)` muncul di log boot host
- [ ] `GET /plugin/session-readcache/metrics` menjawab `200` dengan JSON, dan `mode` bernilai `list-memo`
- [ ] `list.hits` atau `list.staleServed` naik setelah daftar sesi dibuka berulang
- [ ] `snapshot.saves` naik setelah scan selesai, dan `snapshot.failures` tetap `0`

## 11. Verifikasi

| Yang diklaim | Perintah | Keluaran yang diharapkan |
| --- | --- | --- |
| Kontrak unit | `node tests/logic.mjs` | `28/28 pass` |
| Bukti lewat batas host | `node tests/runtime-smoke.mjs` | `STATUS: PROVEN` |
| Balasan dari memo tidak menunggu pemindaian | `node artifacts/perf/repro-dispose-stall.mjs` | `PASS`, reply 0,1 ms |
| Idem pada korpus asli | `node --import <tsx> artifacts/perf/repro-dispose-stall-real.mjs` | `PASS`, reply 4 ms |
| Memo tetap converge ke kebenaran host | `node artifacts/perf/verify-dispose-convergence.mjs` | `8/8 checks pass` |
| Serialisasi tidak di jalur respons | `node artifacts/perf/probe-snapshot-response-path.mjs` | `scan-resolved -> caller-resumed -> stringify` |
| Memo bertahan lintas dispose di host hidup | `curl http://127.0.0.1:13080/plugin/session-readcache/metrics` | `memo.warm:true` sementara `disposedInvalidations:6` |

Skrip di `artifacts/` tidak ikut ter-commit (folder itu di-ignore), jadi baris
terakhir bukan perintah yang bisa dijalankan dari repo yang dikloning.

## 12. Keputusan terbuka

1. **Kunci metrik berubah.** `lifecycle.disposedDrops` diganti
   `lifecycle.disposedInvalidations`, karena memo tidak lagi dibuang. Kalau ada
   konsumen luar endpoint metrik, kunci lama bisa dikembalikan sebagai alias
   satu rilis.
2. **Opsi inert.** `maxEntries` dan `maxTotalEvents` tidak lagi melakukan apa-apa.
   Menghapusnya mengubah bentuk konfigurasi; membiarkannya membuat metrics
   melaporkan angka yang tidak pernah dipakai.
3. **Salinan per pemanggil.** Kontrak "satu pemanggil tidak bisa mengotori
   pemanggil lain" membuat setiap balasan O(jumlah sesi). Melepas kontrak itu
   membuat balasan O(1), tapi mengubah perilaku yang dijanjikan README.
4. **Batas baris yang dibuang.** `session/disposed` menandai memo basi, bukan
   membuang barisnya. Batas yang lebih rapat bisa diambil dengan
   `target.stat(id)` milik host, tapi menambah ketergantungan API host baru di
   jalur event.
5. **Jendela seed boot.** `snapshotMaxAgeMs` bawaan 10 menit lebih sempit dari
   jeda \"idle lalu restart\" yang paling sering terjadi. Terukur di host hidup:
   saat restart, snapshot terakhir berumur 56 menit, seed ditolak
   (`snapshot too old (3357s); rescanning`), dan reply pertama membayar scan
   penuh. Dua jalan menutupnya: naikkan jendela ke 24 jam (satu baris config,
   tanpa I/O baru), atau tulis ulang snapshot secara berkala (kode baru plus
   penulisan 4,7 MB per siklus).

## 13. Prinsip yang tidak boleh dilanggar

- Cache bersifat advisory: setiap kegagalan jatuh ke method asli.
- Set faithfully pada pembatalan: pemanggil yang sudah dibatalkan tidak pernah
  dilayani dari memo dan tidak dihitung.
- Bungkus hanya baca.
- Mount tidak boleh mati diam-diam.
- Klaim harus punya sumber. Angka yang hanya hasil pembacaan kode diberi label
  **Inferred**, angka yang belum diuji diberi label **Perlu dikonfirmasi**.

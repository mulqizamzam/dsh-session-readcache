# dsh-session-readcache

Cache baca untuk `sessionPersistence.list()` di DSH: satu scan direktori sesi
memakan median 12,9 detik pada korpus 5.343 log, dan memo menurunkannya jadi
balasan 1,4 milidetik (angka dan sumbernya di bagian 7.4).

> Dokumen ini ditulis dari isi file di repository ini. Setiap perintah, path, nama
> environment variable, dan port diberi label sumbernya. Yang tidak bisa diverifikasi
> dari file ditandai **Perlu dikonfirmasi**. Klaim yang hanya hasil pembacaan kode,
> bukan hasil eksekusi pada sesi penulisan dokumen ini, diberi label **Inferred**.
>
> Syarat yang harus dipenuhi plugin ini ada di `PRD.md`. Dokumen ini menjelaskan
> cara pakainya.

## Daftar Isi

1. Ringkasan
2. Prasyarat
3. Instalasi
4. Konfigurasi
5. Database / Layanan Eksternal
6. Menjalankan Proyek
7. Penggunaan Pertama / Mulai Cepat
8. Struktur Proyek
9. Perintah Umum
10. Pengujian
11. Pemecahan Masalah
12. Panduan Pengembangan
13. Deployment
14. Catatan Keamanan
15. FAQ
16. Checklist Akhir
17. Lampiran: Catatan Inventaris

---

## 1. Ringkasan

`dsh-session-readcache` adalah plugin (_add-on_) untuk DeepSeek Harness yang memasang
sebuah cache baca di depan satu method baca pada service `sessionPersistence` milik
host, yaitu `list()`. Plugin ini tidak mengubah kode host sama sekali.

**Sejarah singkat yang wajib diketahui:** versi pertama plugin membungkus `inspect()`
dan `list()`. Pada host `0.2.0-rc.2` method `inspect` dihapus dari service
(`sessionPersistence` sekarang hanya punya `list`; baca satu sesi pindah ke
`sessionQuery.observeSession`, dan host sudah membawa cache sendiri untuk jalur itu,
di-key revisi `stat`, berkapasitas 5). Versi plugin sejak 2026-10-10 karena itu
hanya membungkus `list()`, dan kegagalan-mount diam-diam pada host lama sudah
ditutup dengan mode `inert` yang tetap memasang route metrics.

Istilah yang perlu diketahui sebelum lanjut:

| Istilah | Arti |
| --- | --- |
| **Scan direktori** | `list()` membaca seluruh direktori sesi dan mengurai header tiap sesi. Pada host ini scan itu median 12,9 detik untuk 5.343 log (bagian 7.4), dan itulah yang di-cache plugin. |
| **stat / revisi file** | Pembacaan metadata file (ukuran, waktu modifikasi, inode), dipakai untuk mencocokkan data yang sudah dibaca dengan kondisi file saat ini. Mekanisme ini milik cache `inspect` per sesi yang sudah dihapus (host `0.2.0-rc.2`). Jalur `list()` yang dibungkus plugin ini tidak melakukan `stat`; `stat` per log dilakukan host di dalam `list()`-nya sendiri. |
| **TTL (time to live)** | Lama waktu sebuah hasil cache dianggap masih segar sebelum harus dihitung ulang. |
| **Stale window** | Jendela waktu tambahan setelah TTL habis, ketika hasil lama tetap dikembalikan sementara perhitungan baru berjalan di belakang. |
| **Memo** | Satu nilai yang disimpan sementara supaya perhitungan mahal tidak dilakukan berulang kali dalam waktu dekat. |
| **Coalescing (penggabungan)** | Beberapa permintaan yang datang bersamaan digabung menjadi satu pekerjaan baca yang sama. |
| **Snapshot** | Salinan hasil `list()` terakhir yang ditulis ke disk supaya proses yang baru start tidak perlu menghitung ulang dari nol. |
| **ABI** | _Application Binary Interface_. Modul native (_compiled_) harus cocok dengan versi Node yang memuatnya, jika tidak akan gagal dimuat. |

Yang ditambahkan plugin, semuanya dari `lib/index.js`:

- Memo `list` ber-TTL pendek dengan penggabungan permintaan (_coalescing_) yang
  sedang berjalan. Sumber nilai default: `lib/index.js:21-33`.
- Jendela stale untuk `list`, supaya pemanggil tidak menunggu scan yang memakan
  detik-detik.
- Invalidasi saat **sesi dibuang** (`session/disposed`): memo ditandai basi, bukan
  dibuang. Pemanggil berikutnya dilayani dari memori dalam hitungan milidetik dan
  penyegaran berjalan di belakangnya, sehingga satu peristiwa satu baris tidak lagi
  memaksa memindai ulang direktori penuh. Plugin hanya menanyakan host untuk baris
  yang belum pernah ditulis ke disk, jadi pertanyaannya yang murah. Pada event dispose, plugin bertanya ke host apakah ARTIFAK sesi itu masih ada
di disk, lewat `stat(id, { source: 'disk' })`. Host yang mendukung opsi itu
menjawab dari artifact durable, bukan dari tracker in-memory, jadi sesi yang
dibuang tanpa pernah ditulis langsung hilang dari memo. Host yang mengabaikan
opsi itu menjawab dari tracker, dan tracker masih memegang sesi sampai handle
tulis ditutup; di sana barisnya bertahan sampai penyegaran di belakang selesai,
seperti sebelum C1. Jalur `delete()` juga tidak memberi tahu plugin:
`delete()` tidak mempublikasikan `session/disposed`, jadi baris yang dihapus dari
store juga bertahan di memo sampai penyegaran berikutnya. Karena
  itu `disposeRowsRemoved` membaca 0 pada host ini. Itu informasi, bukan
  kegagalan. Batas basi untuk perubahan lain tetap sama dengan jendela stale
  yang sudah dipakai plugin ini.
- Snapshot SQLite dari scan terakhir, supaya restart tidak membayar scan penuh
  untuk reply pertamanya.
- Dua endpoint HTTP pada web server host untuk melihat penghitung (_metrics_) dan
  untuk membersihkan cache (_purge_).

Ruang lingkup plugin dibatasi pada method baca. Penulisan sesi, `load`, `prepare`,
dan perbaikan data tidak disentuh. Bukti dan batasan keamanan ada di
`SECURITY-AUDIT.md`.

---

## 2. Prasyarat

Semua alat yang dibutuhkan beserta cara memastikan sudah terpasang:

| Alat | Versi | Perintah cek | Sumber versi |
| --- | --- | --- | --- |
| Node.js | `>=20` | `node --version` | `package.json` baris engines |
| DSH host | `>=0.1.1-rc.1` | `dsh --version` | `package.json` baris dsh.engines |
| pnpm | Tidak disetel di repo | `pnpm --version` | `pnpm-lock.yaml` lockfileVersion 9.0 |
| C toolchain (`gcc`, `g++`, `make`, `python3`) | Tidak disetel di repo | `gcc --version` | dibutuhkan hanya untuk rebuild modul native |

Dua hal yang perlu diperhatikan:

- **Modul native punya syarat Node sendiri.** `pnpm-lock.yaml` mencatat
  `engines: {node: '>=22'}` untuk `better-sqlite3@13.0.3`. Jadi walaupun
  `package.json` plugin menyatakan `>=20`, lockfile menyatakan modul native itu
  sendiri butuh `>=22`. Gunakan Node 22 atau lebih baru. **Perlu dikonfirmasi**
  oleh pembaca: versi Node yang benar-benar dipakai tidak ada file di repo ini
  yang mengunci.
- **Tidak ada akun, API key, token, atau layanan berbayar.** Plugin tidak
  memanggil jaringan sama sekali. Ketidaksiluan ini disengaja, bukan sekadar tidak
  dibahas.

---

## 3. Instalasi

Karena plugin ini adalah paket npm yang juga merupakan plugin DSH, ada dua langkah:
pasang dependensi di folder plugin, lalu tautkan plugin itu ke profil web DSH.

### 3.1 Pasang dependensi

Package manager yang mengunci dependensi adalah **pnpm**, terlihat dari file
`pnpm-lock.yaml` yang ada di root. Perintah install mengikuti itu:

```bash
cd /home/administrator/agent-workspace/dsh-custom/plugins/dsh-session-readcache
pnpm install
```

(`pnpm install` bersifat **Inferred** dari keberadaan `pnpm-lock.yaml`. Repo ini
tidak memuat CI atau `Makefile` yang menjalankan perintah ini secara literal.)

### 3.2 Tautkan plugin ke profil web DSH

```bash
dsh plugin --profile web add link:/home/administrator/agent-workspace/dsh-custom/plugins/dsh-session-readcache
```

Perintah ini diambil apa adanya dari bagian Install di README lama repository ini.

Kalau versi `dsh` yang dipakai mendaftarkan dependensi tetapi tidak menambahkan
bundle secara otomatis, tambahkan `"dsh-session-readcache"` ke `dsh.profile.bundles`
di `~/.dsh/profiles/web/package.json`, lalu restart web server. Server yang sedang
berjalan menyimpan modul yang sudah ter-resolve, jadi perubahan tidak aktif
sampai restart. Restart web server adalah tindakan pemilik host.

### 3.3 Environment setup

Tidak ada file `.env.example` di repo ini. Satu-satunya environment variable yang
dibaca oleh kode adalah `DSH_HOME`, dipakai hanya sebagai fallback untuk menentukan
lokasi file snapshot (`lib/index.js:361-362`). Kalau host sudah menyediakan service
`dshHomePath`, variabel ini tidak dipakai. Lihat bagian 5.

### 3.4 Perintah pembuktian bahwa instalasi berhasil

Setelah dependensi terpasang, buktikan modul native benar-benar bisa dimuat, bukan
hanya file-nya ada. Yang perlu dicek ada di folder `prebuilds/`, karena
`better-sqlite3` 13.x mengirim binary siap pakai, bukan hasil kompilasi di
`build/Release/` seperti versi lama.

```bash
ls -la node_modules/better-sqlite3/prebuilds/
```

Lalu uji muat sungguhan. Perintah ini diambil apa adanya dari bagian
"Verifikasi hasilnya" di README lama repository ini:

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

Kalau `LOAD_TEST_OK` tidak muncul, modul yang dibangun belum benar dan jangan
dipakai.

### 3.5 Rebuild modul native bila perlu

README lama repository ini mencatat bahwa `$HOME` pada host itu read-only, sehingga
npm dan `node-gyp` gagal tanpa pengalihan cache. Dua perintah di bawah diambil
apa adanya dari README lama:

```bash
cd /home/administrator/agent-workspace/dsh-custom/plugins/dsh-session-readcache
npm_config_devdir="$PWD/.npm-cache/node-gyp" npm rebuild better-sqlite3 --cache ./.npm-cache
```

Atau, kalau seluruh dependensi perlu dibangun ulang:

```bash
npm_config_devdir="$PWD/.npm-cache/node-gyp" npm install --cache ./.npm-cache
```

`--cache ./.npm-cache` memindahkan cache npm, dan
`npm_config_devdir="$PWD/.npm-cache/node-gyp"` memindahkan cache `node-gyp`.
Alasannya tidak trivial: tanpa kedua pengalihan itu, `npm i` gagal dengan
`EROFS open '/home/administrator/.npm/_cacache/...'` dan `node-gyp` gagal dengan
`ENOENT: no such file or directory, mkdir '/home/administrator/.cache/node-gyp'`,
lalu instalasi di-rollback. `.npm-cache/` sudah masuk `.gitignore`, jadi cache ini
tidak ikut ter-commit.

---

## 4. Konfigurasi

Tidak ada file konfigurasi terpisah. Konfigurasi datang dari baris plugin di
`cordis.patch.yml`, yang disisipkan ke konfigurasi Cordis pada profil DSH.
`package.json` mendaftarkan `cordis.patch.yml` sebagai patch bundle.

Semua kunci opsional. Nilai di bawah adalah default yang tertera di
`lib/index.js:21-33`, dan nilai yang sama ditulis ulang di `cordis.patch.yml`.

| Kunci | Default | Fungsi | Boleh 0? |
| --- | --- | --- | --- |
| `enabled` | `true` | `false` menonaktifkan plugin tanpa uninstall: `apply()` langsung keluar dan tidak membungkus apa pun (`lib/index.js:279-281`) | tidak, nilai selain `false` diperlakukan aktif |
| `listTtlMs` | `5000` | Selama jendela ini hasil scan `list()` dianggap segar dan dilayani sebagai hit | ya, `0` membuat memo selalu basi (`lib/index.js:56-62`) |
| `listMaxStaleMs` | `120000` | Setelah TTL habis tapi masih di dalam jendela ini, hasil scan terakhir dikembalikan sambil refresh berjalan di belakang | ya, `0` mempertahankan perilaku TTL ketat (`lib/index.js:56-62`) |
| `snapshotMaxAgeMs` | `86400000` | Umur maksimum snapshot yang boleh mengisi memo saat boot. 24 jam, bukan 10 menit: baris hanya ditulis ulang setelah scan, jadi jeda "idle lalu restart" sering lebih panjang dari jendela pendek (bagian 7.4) | ya, `0` mematikan boot seeding (`lib/index.js:56-62`) |
| `snapshotPath` | diturunkan | Lokasi file snapshot SQLite secara eksplisit | string kosong berarti pakai turunan (`lib/index.js:353-354`) |

Kunci `maxEntries` dan `maxTotalEvents` dihapus pada 2026-10-21. Keduanya sisa
dari cache `inspect` per sesi yang sudah dihapus bersama host `0.2.0-rc.2`, dan
tidak melakukan apa-apa sejak 2026-10-10. Patch lama yang masih menyebutkannya
diabaikan tanpa efek, dan metrics tidak lagi melaporkannya.

Contoh bentuk konfigurasi, diambil dari `cordis.patch.yml`:

```yaml
- insert:
    - id: session-readcache
      name: dsh-session-readcache
      config:
        listTtlMs: 5000
        listMaxStaleMs: 120000
        snapshotMaxAgeMs: 86400000
```

Semua nilai di atas adalah nilai yang benar-benar ada di file, bukan placeholder.
Kalau Anda mengubahnya, pastikan tetap bilangan bulat. Nilai yang bukan bilangan
bulat, negatif (untuk kunci yang tidak menerima `0`), atau di luar rentang safe
integer akan diabaikan dan default yang dipakai, kecuali pada `listTtlMs`,
`listMaxStaleMs`, dan `snapshotMaxAgeMs` yang menerima `0` sebagai nilai bermakna
(`lib/index.js:56-62`). Yang berubah: nilai tidak valid **tidak lagi jatuh ke
default tanpa jejak**. Setiap kunci yang ditolak dinamakan di log host saat mount,
dengan bentuk `[session-readcache] invalid config, default used: listTtlMs="8"`
(`lib/index.js:297`). Begitu pula `enabled` yang bukan boolean: hanya nilai
`false` persis yang mematikan plugin, dan nilai lain memicu peringatan
(`lib/index.js:279`).

### 4.1 Waktu: TTL memakai jam monotonik

`listTtlMs`, `listMaxStaleMs`, dan umur memo `list()` dihitung dari **jam
monotonik** (`performance.now()`), bukan `Date.now()` (`lib/index.js:47-50`).
Alasannya: langkah jam dinding (koreksi NTP, jam manual) tidak boleh bisa
memperpanjang hidup memo atau membuatnya abadi. Konsekuensi jujur: batas waktu
ini hanya bermakna di dalam satu proses, dan itu memang ruang lingkupnya.

Snapshot adalah pengecualian yang disengaja. `saved_at` dan pemeriksaan
`snapshotMaxAgeMs` tetap memakai **jam dinding**, karena nilainya ditulis ke disk
dan dibaca kembali oleh proses lain di mana waktu monotonik tidak berarti apa-apa
(`lib/index.js:47-50`). Kedua sumber waktu tinggal di satu objek `clock` yang
diekspor (`lib/index.js:39-50`); tes memakainya untuk memasang jam palsu, dan
produksi tidak pernah mengubahnya.

---

## 5. Database / Layanan Eksternal

Repo ini **punya** database: satu file SQLite berisi snapshot satu baris. Tidak ada
layanan eksternal, tidak ada koneksi jaringan, tidak ada kredensial.

### 5.1 Skema tabel

Tabel dibuat otomatis saat database pertama kali dibuka untuk tulis, dengan SQL ini
persis seperti tertulis di `lib/index.js:120-124`:

```sql
CREATE TABLE IF NOT EXISTS readcache_list_snapshot (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  saved_at INTEGER NOT NULL,
  headers TEXT NOT NULL
)
```

Penjelasan tiap kolom:

| Kolom | Tipe | Isi |
| --- | --- | --- |
| `id` | INTEGER | Selalu `1`. Batasan `CHECK (id = 1)` membuat tabel ini hanya mungkin punya satu baris. |
| `saved_at` | INTEGER | Waktu milliseconds (`clock.wall()`) saat scan selesai, bukan saat baris ditulis. |
| `headers` | TEXT | Hasil `list()` dalam bentuk JSON. |

Selain kolom, skema punya **versi** di header database: `PRAGMA user_version`
diset ke `SNAPSHOT_SCHEMA_VERSION` setiap kali plugin menulis
(`lib/index.js:126`). Nilai `0` dianggap legal karena itu layout yang selama ini
dipakai; nilai lain yang tidak dikenal membuat baris ditolak, bukan di-parse.
Tidak ada migrasi: file lama dibiarkan, ditimpa oleh scan berikutnya.

Isi `headers` divalidasi bentuknya sebelum dipercaya: harus array, setiap elemen
harus **snapshot sesi**: objek dengan `header` objek yang `header.id`-nya string,
yaitu bentuk yang benar-benar dikembalikan `SessionPersistence.list()`
(`Promise<readonly SessionPersistenceSnapshot[]>`; kedua pemanggil in-tree,
`session-query` `listPersisted` dan ACP `sessionList`, membaca
`snapshot.header.id`). Sebelum patch 2026-10-11 pemeriksaannya meminta `id`
 string di tingkat TERATAS, jadi setiap baris asli ditolak dan boot seeding
tidak pernah menyajikan apa pun. Gejala live: `snapshot headers are not
session headers; rescanning` dengan `saves=1, failures=1`, dan memo yang tidak
pernah seed. Elemen juga tidak boleh punya key `__proto__`, `constructor`, atau
`prototype`, diperiksa di snapshot DAN di dalam `header`-nya (penjaga
prototype pollution, `lib/index.js`). `copy()` membangun ulang setiap snapshot
key demi key, dan `header`-nya juga, sehingga key berbahaya tidak pernah ikut
ke objek pemanggil.

### 5.2 Penulisan

Tidak ada perintah migrasi, seed, atau init. Baris ditulis sendiri oleh plugin,
setelah scan `list()` selesai, di luar jalur respons pemanggil: serialisasi
seluruh daftar (O(jumlah sesi), terukur 4,0 ms untuk 4.016 snapshot) dijadwalkan
pada satu putaran macrotask, sehingga reply yang menutup scan sampai ke pemanggil
lebih dulu (`lib/index.js:248-253`). Penulisan memakai satu pernyataan berparameter
(`?`), jadi penulisan ulang satu baris bersifat atomik dan tidak membutuhkan
tulis-tempel-lalu-rename seperti pada file JSON biasa. Tidak ada satu pun SQL di
repo ini yang dirakit dari string masukan: id sesi hanya pernah menjadi nilai
(`lib/index.js:267`), dan `PRAGMA user_version` memakai konstanta internal.

### 5.3 Lokasi file

Kalau `snapshotPath` tidak ditetapkan, plugin mencoba tiga sumber secara berurutan
(`lib/index.js:347-368`):

| Urutan | Sumber | Hasil |
| --- | --- | --- |
| 1 | `config.snapshotPath` | Dipakai apa adanya bila string tidak kosong |
| 2 | Service host `dshHomePath('plugins', 'session-readcache', 'list-snapshot.db')` | Dipakai bila service tersedia dan mengembalikan string tidak kosong |
| 3 | Environment variable `DSH_HOME`, digabung `plugins/session-readcache/list-snapshot.db` | Dipakai bila `DSH_HOME` ada dan tidak kosong |
| 4 | Tidak ada sumber yang tersedia | Persistensi snapshot dimatikan, **bukan** ditebak |

Kasus nomor 4 disengaja: cache bersifat advisory dan tidak boleh mengarang lokasi
tulis. Daftar persis untuk keadaan ini ada di `tests/logic.mjs:391-407`, yang
memastikan `snapshot.path` bernilai `null` saat tidak ada home, dan `list()` tetap
berfungsi.

Direktori induk dibuat otomatis dengan `mkdir` recursive saat database dibuka
(`lib/index.js:116`).

### 5.4 Yang terjadi kalau database tidak bisa dipakai

Semua kegagalan di jalur snapshot ditangkap dan tidak pernah dilempar ke pemanggil.
Akibatnya plugin tetap berjalan. Failure mode yang tercatat di kode:

| Keadaan | Yang terjadi | Di mana |
| --- | --- | --- |
| `better-sqlite3` gagal di-import | `openDatabase` mengembalikan `{ error }`, tidak melempar | `lib/index.js:108-115` |
| File rusak atau bukan SQLite | Handle ditutup, error dikembalikan | `lib/index.js:128-135` |
| Jalur baca tidak pernah menulis | Koneksi dibaca-only (`readonly`, `fileMustExist`); cache tidak butuh izin tulis hanya untuk melihat | `lib/index.js:132` |
| Versi skema tidak dikenal | Baris ditolak, scan nyata dijalankan, dicatat di `snapshot.notes` | `lib/index.js:176-178` |
| Baris snapshot terlalu besar | Ditolak berdasarkan `length()` sebelum di-parse, dicatat | `lib/index.js:183-193` |
| Baris snapshot bukan header sesi | Ditolak, scan nyata dijalankan, dicatat di `snapshot.notes` | `lib/index.js:172-181` |
| `saved_at` dari masa depan | Ditolak, scan nyata dijalankan, dicatat | `lib/index.js:404` |
| Snapshot terlalu tua | Ditolak, scan nyata dijalankan, dicatat | `lib/index.js:409` |
| Database terkunci (writer lain) | Tulis ditolak (`SQLITE_BUSY` dari better-sqlite3; plugin tidak menyetel `busy_timeout`), dicatat; `list()` tetap dijawab | `lib/index.js:273-275` |
| Tulis snapshot gagal (disk penuh, lokasi tak bisa ditulis) | Dicatat di `snapshot.notes`, reply pemanggil tidak terpengaruh | `lib/index.js:488` |
| Mount sudah dilepas sebelum tulis landing | Ditolak, dicatat | `lib/index.js:265` |

Alasan kegagalan selalu terlihat di endpoint metrics pada bagian 7, field
`snapshot.notes` (5 terakhir) dan `snapshot.failures` (jumlah total). Field
`snapshot.notes` juga dipakai untuk kegagalan pencabutan baris sesi yang dibuang,
jadi isinya bukan cuma soal snapshot; nama fieldnya historis. Array `notes`
sendiri dibatasi 20 entri (`lib/index.js:93`) supaya kegagalan yang berulang
setiap scan tidak tumbuh tanpa batas selama proses hidup.

### 5.5 Kebersihan data

Indeks `id = 1` membuat tabel self-limiting: satu baris, ditimpa setiap scan.
Tidak ada data kedaluwarsa yang menumpuk. Kalau file snapshot dihapus, plugin akan
menjalankan scan penuh sekali lalu menulis ulang file itu. Retensi diatur oleh
`snapshotMaxAgeMs` saat membaca, dan batas ukuran `SNAPSHOT_MAX_BYTES`
(`lib/index.js:86`) saat membaca dan menulis: baris yang lebih besar dari itu
ditolak, bukan dipotong. Penghapusan hanya berlaku untuk file di dalam direktori
snapshot milik plugin sendiri.

---

## 6. Menjalankan Proyek

Repo ini bukan aplikasi mandiri. Ia adalah plugin yang di-host oleh
`dsh web`. Jadi "menjalankan proyek" berarti memasang plugin lalu menyalakan host.

### 6.1 Perintah boot host

Bentuk perintah yang benar dapat diambil dari `tests/runtime-smoke.mjs:57-58`, yang
menjalankan binary CLI host dengan argumen berikut: `web`, `--port 0`,
`--no-open`:

```bash
dsh web --port 13080 --no-open
```

Catatan tentang tiap bagian perintah ini:

- Profil dipilih oleh sub-perintah `web` itu sendiri. Host memperlakukan
  `dsh web` sama dengan `dsh --profile web`: token aplikasi di awal argv
  diperluas menjadi `--profile <nama>` (sumber: `apps/cli/src/args.ts` di
  checkout host, perluas `['--profile', ...argv]`). Karena itu
  `dsh web --profile web ...` **ditolak** host dengan pesan
  `select a profile only once`: profil terpilih dua kali dan child host mati
  sebelum boot. Bentuk setara yang valid: `dsh --profile web --port 13080
  --no-open`.
- Port hanya relevansi untuk pengujian. `tests/runtime-smoke.mjs` memakai
  `--port 0`, yang berarti OS memilih port sendiri dan host mencetak URL dengan
  port tersebut di baris `dsh web: http://...`. Angka 13080 yang sering muncul di
  dokumen lama adalah port host pengembangan, bukan default yang dipatok plugin.
  Skrip pengukuran lama yang memakai port tetap (`smoke-test.mjs`,
  `measure-e2e.mjs`) sudah dihapus karena jalur RPC-nya (`POST /api/<method>`)
  tidak ada lagi di host 0.2.0-rc.2: RPC sekarang berjalan di atas WebSocket
  `connection`.
- `--no-open` mencegah host membuka browser sendiri.

**Perlu dikonfirmasi:** nilai default port milik `dsh web` itu sendiri tidak
settle dari file di repo ini. Repo ini hanya memuat `13080` sebagai konvensi
pengukuran. Jangan menganggap `13080` sebagai default.

### 6.2 Bentuk keberhasilan

Plugin memberi dua tanda bahwa ia benar-benar terpasang:

1. Di stderr atau log host, ada baris mount dengan ringkasan konfigurasi
   (`lib/index.js:824-825`):

   ```text
   [session-readcache] mounted (mode=list-memo, listTtlMs=5000, listMaxStaleMs=120000, snapshotMaxAgeMs=86400000, snapshot=on)
   ```

   Baris ini ditulis dua kali, sekali ke `process.stderr` dan sekali ke
   `ctx.logger`. String persis yang dicari ada di `tests/runtime-smoke.mjs:83`:
   `out.includes('[session-readcache] mounted')`.

2. Endpoint metrics menjawab dengan JSON. Perintah dan bentuk responsnya ada di
   bagian 7.

Kalau `ctx.webServer` belum tersedia saat mount, plugin tetap berjalan, mencatat
`[session-readcache] webServer unavailable at mount; metrics/purge endpoints will
register when it appears` (`lib/index.js:819`), dan endpoint didaftarkan kemudian
lewat `ctx.inject(['webServer'], ...)` saat service itu muncul
(`lib/index.js:806-820`). Bila service itu tidak pernah ada, plugin tetap cache
tanpa endpoint. Boot tidak pernah diblokir oleh ketiadaan endpoint, dan
ketiadaan web surface tidak lagi membuat plugin tidak aktif sama sekali: itu
perilaku lama yang sudah diperbaiki (lihat `lib/index.js:10-19`).

### 6.3 Build, lint, service lain

Tidak ada. Repo ini tidak punya script build, tidak punya linter, tidak punya
`Makefile`, `Taskfile.yml`, atau `justfile`, dan tidak punya konfigurasi CI. Tidak
ada perintah produksi terpisah karena plugin tidak punya proses sendiri. Plugin
ikut siklus hidup host, mount saat host start dan unmount saat host berhenti.

---

## 7. Penggunaan Pertama / Mulai Cepat

Contoh lengkap dari start sampai melihat bukti plugin bekerja.

### 7.1 Lihat penghitung

```bash
curl http://127.0.0.1:13080/plugin/session-readcache/metrics
```

Bentuk responsnya diambil dari handler di `lib/index.js`:

```json
{
  "mode": "list-memo",
  "list": { "hits": 0, "misses": 0, "staleServed": 0 },
  "lifecycle": { "disposedInvalidations": 0, "createdInvalidations": 0, "disposeRowsRemoved": 0, "purgeDrops": 0 },
  "memo": { "warm": false, "ageMs": null, "inflight": false },
  "config": { "listTtlMs": 5000, "listMaxStaleMs": 120000, "snapshotMaxAgeMs": 86400000 },
  "snapshot": { "path": null, "seedResolved": false, "seeded": false, "saves": 0, "failures": 0, "notes": [] }
}
```

`mode` bernilai `list-memo` saat plugin membungkus `list`, atau `inert` saat
service host tidak punya method itu. Mode `inert` tetap memasang route supaya
keadaan plugin tetap terlihat dari luar; itu jalan degradasi yang sudah teruji.

Angka nol di atas adalah keadaan awal yang sebenarnya.

Arti setiap field:

| Field | Arti | Kapan naik |
| --- | --- | --- |
| `mode` | Lapisan mana yang aktif | `list-memo` atau `inert` |
| `list.hits` | `list()` dilayani dalam TTL | Umur memo kurang dari `listTtlMs` |
| `list.misses` | Scan direktori nyata dijalankan | Termasuk scan yang dipicu refresh di belakang, bukan hanya pemanggil langsung |
| `list.staleServed` | Dilayani dari jendela stale | Umur memo antara `listTtlMs` dan `listTtlMs + listMaxStaleMs` |
| `lifecycle.disposedInvalidations` | Memo ditandai basi karena ada sesi dibuang | Event `session/disposed` datang saat memo hangat. Nama field sebelumnya `disposedDrops`: memo tidak lagi dibuang, hanya ditandai basi |
| `lifecycle.createdInvalidations` | Memo **dibuang** karena ada sesi baru dibuat | Event `session/created` datang saat memo hangat. Berbeda dari dispose: memo tidak bisa sekadar ditandai basi, karena jalur stale akan menyajikan array lama sekali lagi dan array itu tidak mungkin memuat sesi baru. Angka nol berarti setiap pembuatan terjadi saat memo dingin, jadi tidak ada pemanggil yang dirugikan |
| `lifecycle.disposeRowsRemoved` | Jumlah dispose yang benar-benar mencabut satu baris dari memo | Baris dicabut kalau host menjawab "tidak ada artifact-nya". Di host ini angkanya 0: pada jalur dispose jawaban host selalu "terdaftar", dan pada jalur delete plugin tidak pernah ditanya. Itu informasi, bukan kegagalan |
| `lifecycle.purgeDrops` | Memo dibuang melalui endpoint purge | POST purge saat memo hangat |
| `memo.warm` | Memo sedang berisi hasil scan | Setelah satu scan selesai |
| `memo.ageMs` | Umur memo dalam ms | `null` saat memo kosong |
| `memo.inflight` | Ada scan yang sedang berjalan | Selama satu scan berlangsung |
| `snapshot.path` | Lokasi file snapshot, `null` bila dimatikan | Dihitung sekali saat mount |
| `snapshot.seedResolved` | Seed boot sudah dicoba | Setelah satu pemanggilan `list()`, apa pun hasilnya |
| `snapshot.seeded` | Memo sedang holds data dari snapshot | True sampai scan nyata berikutnya menggantikannya (`lib/index.js:747`) |
| `snapshot.saves` | Snapshot yang berhasil ditulis | Setiap penulisan row yang sukses |
| `snapshot.failures` | Snapshot yang gagal dibaca atau ditulis | Setiap penolakan: rusak, versi skema asing, terlalu besar, terlalu tua, `saved_at` di masa depan, gagal tulis |
| `snapshot.notes` | Buffer masalah terakhir plugin. Dua jenis teks: alasan persistensi snapshot tidak bekerja, dan baris `dispose: stat failed for <id>: <alasan>` ketika host tidak bisa ditanya apakah sesi yang dibuang masih punya artifact di disk. Bentuk kedua punya dua varian: pesan error aslinya, atau `the answer could not be applied` kalau jawabannya tidak bisa dipakai. Tidak ada catatan untuk host yang memang tidak punya method `stat`, karena itu bukan kegagalan. Nama field-nya historis: isinya bukan cuma soal snapshot | Maksimal 5 catatan terakhir (`lib/index.js:750`). Catatan dispose berarti baris sesi yang dibuang bisa jadi masih basi, jadi operator bisa melihatnya |

Penghitung direset setiap restart, karena mereka hidup di dalam closure `apply()`
(`lib/index.js:307`) dan bukan di penyimpanan.

Dua penghitung lifecycle dibaca bersama, bukan sendiri-sendiri.
`disposedInvalidations` menghitung event `session/disposed` yang datang saat memo
hangat. `disposeRowsRemoved` menghitung event-event itu yang benar-benar menghapus
satu baris dari memo. Jadi `disposedInvalidations` besar sementara
`disposeRowsRemoved` nol berarti host menjawab dari tracker, jadi tidak pernah membuktikan ketiadaan artifact
datang: barisnya dipertahankan sampai penyegaran di belakang selesai. Angka nol
di `disposeRowsRemoved` bukan tanda kegagalan, dan bukan tanda plugin tidak
menjalankan apa-apa.

`createdInvalidations` adalah pasangan yang berlawanan arah: ia bergerak saat
sesi baru **masuk**, bukan saat sesi lama keluar. Dispose cukup menandai memo
basi karena baris yang dibuang tetap benar untuk pemanggil berikutnya sampai
penyegaran selesai; pembuatan tidak punya kemewahan itu — array lama secara
logis tidak memuat sesi baru, jadi memo harus dibuang, dan pemanggil berikutnya
membayar satu pemindaian. Karena itu angkanya hanya naik saat memo sedang
hangat; pembuatan dengan memo dingin tidak merugikan siapa pun dan tidak
dihitung. Bandingkan `purgeDrops`: itu juga menghitung memo yang dibuang, tetapi
lewat endpoint purge, bukan lewat event host.

### 7.2 Bersihkan cache satu sesi atau semuanya

```bash
# Bersihkan satu sesi
curl -X POST 'http://127.0.0.1:13080/plugin/session-readcache/purge?id=s1'

# Bersihkan semua entri
curl -X POST 'http://127.0.0.1:13080/plugin/session-readcache/purge'
```

Bentuk responsnya dari `lib/index.js:720-755`:

```json
{ "purged": 1 }
```

Perilaku yang perlu diketahui:

- Metode selain `POST` ditolak dengan status 405 dan badan
  `{ "error": "method not allowed; use POST" }` (`lib/index.js:760-763`).
- Dengan `?id=`, entri itu dihapus dari cache dan dari daftar in-flight.
  `purged: 1` kalau ditemukan, `0` kalau tidak.
- Tanpa `id`, memo `list` dikosongkan, dan `purged` bernilai `1` kalau memo
  sedang hangat atau `0` kalau sudah kosong.
- Pembersihan menaikkan epoch invalidasi. Scan yang sedang berjalan saat itu tidak
  akan memasang hasilnya setelah selesai, sehingga purge tidak bisa dibatalkan
  oleh baca yang sudah terlambat mulai.
- Query `id` tidak lagi punya arti: tidak ada entri per-sesi sejak 2026-10-10,
  jadi parameter itu diabaikan dan seluruh memo yang dibuang.

### 7.3 Bentuk normal setelah dipakai

Setelah beberapa daftar sesi dibuka berulang di GUI, bentuk yang wajar adalah
`list.misses` naik satu per scan nyata, `list.hits` naik untuk panggilan yang
datang dalam 5000 ms setelah scan, dan `list.staleServed` naik sementara
`list.hits` tetap dekat nol. Itu bukan tanda kegagalan: kalau satu scan `list()`
memakan detik, memo dengan TTL 5000 ms sudah basi sebelum pemanggil yang memicunya
selesai. Bentuk itu justru yang sehat pada host seperti ini, dan dijelaskan di
komentar `listMaxStaleMs` pada `lib/index.js`.

### 7.4 Angka yang tercatat di repo

Angka berikut bukan hasil ukur ulang saat dokumen ini ditulis. Semuanya
direkam di dalam repo, di `README.md` lama dan di
`docs/HOST-TICKET-sessionListMetadata.md`:

| Pengukuran | Angka yang tercatat | Sumber |
| --- | --- | --- |
| Scan `list()` langsung pada korpus 3.847 log | 9,76 detik saat cold | `lib/index.js:23-28` |
| Scan header serial saat warm | 2,70 - 3,01 detik | `docs/HOST-TICKET-sessionListMetadata.md` bagian 2.1 E2 |
| Scan header 32-way paralel | 1,43 detik | idem, E3 |
| RPC `session.list` yang ditunggu pengguna | 9,0 - 10,2 detik | idem, E4 |
| Buka ulang sesi yang sama, integrasi log nyata | sekitar 742 ms menjadi sekitar 8 ms | `README.md` lama |
| Corpus yang diukur | 3.852 log, 1,68 GB | idem, E1 |

Angka-angka itu diukur pada satu host dan satu titik waktu, pada korpus yang
jauh lebih kecil dari korpus sekarang. Corpus sesi bertambah terus sehingga
hitungan log berbeda antar run (3.847 / 3.852 / 3.853 / 3.864 tercatat di
repo). Angka-angka ini tidak direproduksi ulang pada 2026-10-21, jadi perlakukan
sebagai catatan pengukuran, bukan jaminan performa. Angka yang terukur pada
2026-10-21 ada di subbagian terakhir bagian ini.

#### Angka hasil ukur ulang, 2026-10-20

Diukur ulang di host ini: korpus 4.016 log, 2,3 GB, `DSH_HOME` =
`/home/administrator/agent-workspace/.dsh`. Sumbernya skrip di `tools/`, yang
ikut ter-commit jadi bisa dijalankan ulang pembaca.

| Pengukuran | Angka | Sumber |
| --- | --- | --- |
| Scan `list()` korpus asli, page cache hangat | 2,15 / 2,34 / 2,38 / 2,62 detik (empat run). Diukur lewat scan pengganti, bukan `list()` host yang sesungguhnya, dan tidak direproduksi ulang pada 2026-10-21 | `tools/measure-session-scan.mjs`, `repro-dispose-stall-real.mjs` |
| Scan `list()` korpus asli, page cache kosong | 77,7 detik. Tidak terukur ulang pada 2026-10-21: page cache tidak bisa dikosongkan tanpa hak root tanpa mengganggu host yang sedang jalan, jadi nilainya tidak diketahui, bukan nol | `tools/measure-session-scan.mjs` |
| Balasan dari memo, 4.016 header | 1,4 - 3,8 ms | idem |
| `list()` setelah satu `session/disposed` | 2,64 detik sebelum fix, 4 ms sesudahnya | `tools/repro-dispose-stall-real.mjs` |
| Scan yang dibuang oleh `session/disposed` | 1, tidak diulang | `tools/verify-dispose-convergence.mjs` |
| Serialisasi snapshot 4.016 header | 2,9 - 4,0 ms, sebelumnya di jalur respons pemanggil | `tools/probe-snapshot-response-path.mjs` |
| Metrik host hidup sebelum fix terpasang | `hits:0, misses:16, staleServed:5, disposedDrops:8, memo.warm:false` | `curl http://127.0.0.1:13080/plugin/session-readcache/metrics` |
| Metrik host hidup setelah fix terpasang | `hits:0, misses:4, staleServed:1, disposedInvalidations:3, memo.warm:true` | idem |
| Seed boot setelah restart | Ditolak: `snapshot too old (3357s); rescanning` | idem |

Baris sebelum fix dibaca dari host yang menjalankan build lama. Baris sesudah fix
dibaca setelah host dimuat ulang dengan build baru. Yang terlihat dari baris
sesudah: kunci metrik ikut berubah ke `disposedInvalidations`, dan memo tetap
hangat melewati tiga `session/disposed`. Kebetulan "tetap hangat" itu sendiri
belum membuktikan dispose tidak membuang memo, karena scan setelah dispose juga
memanaskan memo lagi; yang membuktikannya ada di test `lifecycle: a disposed
session must not make the next list() wait for a scan` dan di skrip
`tools/repro-dispose-stall.mjs`.

Baris seed boot menunjukkan celah nyata yang sudah ditutup: `snapshotMaxAgeMs`
bawaan 10 menit, tapi snapshot terakhir berumur 56 menit saat host dimuat ulang,
jadi seed ditolak dan reply pertama membayar scan penuh. Jendelanya sekarang 24
jam (baris 2026-10-21). Isi snapshot adalah daftar sesi yang perubahannya lambat,
jadi staleness 24 jam jauh lebih murah daripada scan 12,9 detik yang
dibuka pengguna di awal pakai (median atas 5.343 log, diukur 2026-10-21, angka
dan sumbernya di subbagian berikutnya). Angka di tabel ini diukur pada satu host
dan satu waktu; perlakukan sebagai catatan pengukuran, bukan jaminan.

#### Angka hasil ukur ulang, 2026-10-21

Diukur di host ini dengan backend jsonl host yang asli, bukan service palsu.
Korpus saat pengukuran: 5.343 log di 65 direktori proyek. Dua skrip yang ikut
ter-commit adalah sumbernya: `tools/measure-stat-cost.mjs` (biaya `stat()` per
kelas generasi fisik, scan `list()` untuk rasio, dan penskalaan menurut jumlah
direktori proyek) serta `tools/measure-stat-cost-versioned.mjs` (bukti
sebab-akibat: skrip itu menimpa `historicalCorpusRevision()` untuk menghitung
berapa kali fungsi itu dipanggil).

| Pengukuran | Angka | Sumber |
| --- | --- | --- |
| Scan `list()` penuh atas 5.343 baris | 10,3 / 12,9 / 14,4 detik (tiga scan berturut-turut), median 12,9 detik. Antar-run scan ini berada di 7,7 sampai 17,6 detik (tujuh run), jadi penyebut rasio bergerak jauh | `tools/measure-stat-cost.mjs` |
| `stat()` untuk log generasi-4, 1.339 sesi (25% korpus) | median 40,4 ms, maksimum 48,2 ms. Antar-run mediannya 29 sampai 40 ms | idem |
| `stat()` untuk log generasi-0, 4.004 sesi (75% korpus) | median 1,96 detik, maksimum 3,30 detik. Antar-run mediannya 1,4 sampai 2,0 detik | idem |
| `stat()` untuk id yang tidak dikenal | median 40,3 ms, maksimum 76,0 ms | idem |
| Rasio `stat()` terhadap scan `list()` | Bergantung pada scan yang jadi penyebut: 1 : 260 sampai 1 : 520 untuk generasi-4, 1 : 5,3 sampai 1 : 11 untuk generasi-0. Dua komponennya (29-40 ms dan 1,4-2,0 detik untuk `stat()`, 7,7-17,6 detik untuk scan) lebih stabil daripada rasionya | idem |

Mekanismenya yang penting, karena itulah alasan `stat()` bukan probe murah.
Untuk log generasi-0, host menghitung `historicalCorpusRevision()`, yang
menghash SELURUH korpus: 5.343 `readdir` dan 5.343 `stat` di dalam kueri satu
sesi saja. Sesi yang lognya sudah di generasi fisik saat ini (v4) tidak butuh
hash itu. Sumber di checkout host: `stat()` di
`packages/session/session-persistence-jsonl/lib/index.js:2593`, pemanggilan
`historicalCorpusRevision()` di baris 2611, dan definisinya di baris 3127.
Generasi fisik dibaca dari nama file
(`packages/session/session-format/src/filename.js:22`): `session.jsonl` berarti
generasi 0, `session.v4.jsonl` berarti generasi 4.

Biaya satu dispose di host ini SEBELUM aturan C1 dipersempit: median 2,28
detik pekerjaan latar pada disk host (median atas 40 id yang diacak pada run
pertama `tools/measure-stat-cost.mjs`; rata-rata tertimbang komposisi korpus
sekitar 1,5 detik). Pekerjaan itu berada di luar jalur pemanggil, karena host
tidak menunggu listener `session/disposed`
(`packages/core/session/src/index.ts:403-419`).

Setelah persempitan itu, dispose atas sesi yang sudah punya artifact di disk
TIDAK memanggil host sama sekali: nol pekerjaan latar. Yang tetap membayar
`stat()` hanya dispose atas sesi yang hidup tapi belum pernah ditulis, dan itu
jalur murah (penelusuran direktori sesi, tanpa hash korpus) dengan median
40,3 ms dan maksimum 76,0 ms di host ini. Kelas mahal 1,96 detik tidak pernah
muncul di jalur dispose.

Angka-angka tabel 2026-10-20 di atas harus dibaca sebagai rekaman bertanggal,
bukan sebagai biaya `list()` hari ini: angka yang terukur hari ini dan dipakai
sebagai pembanding ada di subbagian ini.

---

## 8. Struktur Proyek

Pohon direktori dan fungsi tiap entri. Hanya dua tingkat yang ditampilkan;
`artifacts/` dan `node_modules/` dipangkas karena isinya bukan sumber.

```
dsh-session-readcache/
├── package.json                     # metadata paket, engines, deps, registrasi patch bundle
├── README.md                        # dokumen ini: cara pakai, konfigurasi, pemecahan masalah
├── PRD.md                           # syarat plugin ini: apa yang harus benar, bagaimana buktinya
├── SECURITY-AUDIT.md                # catatan reachability, bukti eksekusi, batas pengujian
├── cordis.patch.yml                 # baris konfigurasi plugin yang disisipkan ke profil Cordis
├── pnpm-lock.yaml                   # kunci dependensi: better-sqlite3 13.0.3 + node-addon-api 8.9.2
├── .gitignore                       # apa yang tidak boleh masuk commit
├── lib/
│   └── index.js                     # SELURUH implementasi plugin
├── tests/
│   ├── logic.mjs                    # 37 unit test kontrak memo list baru
│   ├── runtime-smoke.mjs            # boot host terisolasi, bukti lewat batas host
│   └── driver-plugin/               # bundle sekali-pakai untuk runtime-smoke (bukan untuk produksi)
├── tools/                           # skrip ukur dan bukti, semuanya bisa dijalankan pembaca
│   ├── measure-stat-cost.mjs        # biaya stat() per kelas generasi + scan list() untuk rasio
│   ├── measure-stat-cost-versioned.mjs  # bukti sebab-akibat historicalCorpusRevision()
│   ├── measure-dispose-burst.mjs    # sebaran dispose, penghitung device, uji saturasi
│   ├── probe-pending-stat.mjs        # jawaban stat() untuk sesi yang dibuat tapi belum ditulis
│   ├── measure-session-scan.mjs      # scan pengganti untuk korpus asli
│   ├── repro-dispose-stall.mjs      # repro: dispose tidak boleh membuat list() berikutnya menunggu scan
│   ├── repro-dispose-stall-real.mjs # idem di korpus asli
│   ├── verify-dispose-convergence.mjs # memo tetap converge ke kebenaran host
│   └── probe-snapshot-response-path.mjs # serialisasi snapshot tidak boleh menahan reply
├── docs/
│   ├── HOST-TICKET-sessionListMetadata.md   # tiket ke owner host, lengkap dengan koreksi
│   ├── HOST-TICKET-stat-corpus-hash.md  # tiket: stat() hash korpus penuh dan tracker in-memory
│   ├── CONTRACT-c1-dispose.md          # kontrak invalidasi dispose, disepakati 2026-10-21
│   └── superpowers/plans/
│       └── 2026-10-05-session-readcache-extensions.md  # rencana pengembangan A + C
├── better-sqlite3/                  # salinan modul native, di-ignore git
├── artifacts/                       # hasil investigasi, reproduksi, laporan breaker/judge
├── .snapshots/                      # salinan baseline, di-ignore git
└── node_modules/                    # hasil install, di-ignore git
```

File yang akan dibuka pertama oleh pembaca baru, urut dari atas:

1. **`lib/index.js`**. Satu-satunya file implementasi. Mulai dari `DEFAULTS` di
   baris 21-35, lalu `apply()` di baris 275, lalu callback `ctx.inject` di baris
   316. Sisanya adalah implementasi cache.
2. **`cordis.patch.yml`**. Delapan belas baris. Ini yang benar-benar diedit saat
   ingin mengubah perilaku plugin lewat konfigurasi.
3. **`tests/logic.mjs`**. Cara kerja plugin dinyatakan sebagai assertion. Nama test
   sudah sangat deskriptif, jadi test ini bisa dibaca sebagai spesifikasi.
4. **`PRD.md`**. Syarat yang harus dipenuhi plugin ini, dengan batas kesegaran
   dan keputusan yang masih terbuka. README menjelaskan cara pakainya, PRD
   menjelaskan apa yang harus benar.

Dua hal yang perlu diketahui soal direktori:

- **`artifacts/` tidak ada di dalam git** (`.gitignore:2`). Isinya laporan
  investigasi dari beberapa putaran pengujian, termasuk `artifacts/REPORT.md` dan
  beberapa `BREAKER.md`. Berguna untuk memahami sejarah, tapi bukan bagian dari
  kontrak yang bisa diandalkan.
- **Tidak ada `LICENSE` di root.** `package.json` menyatakan `"license": "MIT"`,
  tapi berkas lisensinya sendiri tidak ada di repo ini. Ada salinan MIT di dalam
  paket `better-sqlite3`, tapi itu lisensi dependensi, bukan lisensi plugin ini.

---

## 9. Perintah Umum

Perintah disalin apa adanya dari berkas yang ada di repo. Tidak ada perintah yang
direkayasa ulang.

### 9.1 Install dan rebuild

```bash
cd /home/administrator/agent-workspace/dsh-custom/plugins/dsh-session-readcache
pnpm install
```

```bash
npm_config_devdir="$PWD/.npm-cache/node-gyp" npm rebuild better-sqlite3 --cache ./.npm-cache
```

```bash
npm_config_devdir="$PWD/.npm-cache/node-gyp" npm install --cache ./.npm-cache
```

### 9.2 Pengujian

```bash
node tests/logic.mjs
```

Aturan uji terhadap host hidup (boot host terisolasi + driver di dalam host):

```bash
node tests/runtime-smoke.mjs
```

Perintah tersebut membangun DSH_HOME terisolasi di `tmpdir`, menyalin profil web
yang sedang hidup, menambahkan satu bundle driver sekali-pakai
(`artifacts/driver-plugin`, hanya untuk uji ini), lalu mem-boot host sungguhan
dengan kode plugin terkini. Yang dibuktikan dari batas host: banner mount
`mode=list-memo`, dua panggilan `sessionPersistence.list()` nyata dari dalam host,
penghitung metrics `list.misses=1` dan `list.hits=1`, serta file snapshot yang
benar-benar ada di disk. Kalau salah satu tidak terlihat, skrip keluar dengan kode
1 (fail-closed).

### 9.3 Pengukuran ulang biaya `stat()`

Dua skrip pengukuran ikut ter-commit supaya angka di bagian 7.4 bisa dijalankan
ulang oleh pembaca. Keduanya hanya membaca store sesi dan tidak pernah menyentuh
`list-snapshot.db`:

```bash
node tools/measure-stat-cost.mjs
```

```bash
node tools/measure-stat-cost-versioned.mjs
```

```bash
node tools/measure-dispose-burst.mjs
```

```bash
node tools/probe-pending-stat.mjs
```

Skrip pertama mengukur biaya satu panggilan `stat()` per kelas generasi fisik,
scan `list()` untuk rasio, dan penskalaan menurut jumlah direktori proyek.
Skrip kedua adalah bukti sebab-akibat: ia menimpa `historicalCorpusRevision()`
untuk menghitung berapa kali host memanggil fungsi itu. Hasil keduanya sudah
tertulis di bagian 7.4.

### 9.4 Verifikasi modul native

```bash
ls -la node_modules/better-sqlite3/prebuilds/
```

### 9.5 Inventory dan membersih cache

```bash
curl http://127.0.0.1:13080/plugin/session-readcache/metrics
```

```bash
curl -X POST 'http://127.0.0.1:13080/plugin/session-readcache/purge?id=s1'
```

```bash
curl -X POST 'http://127.0.0.1:13080/plugin/session-readcache/purge'
```

### 9.6 exempted: build, lint, format

Repo ini tidak punya perintah build, lint, atau format. Tidak ada
`package.json` `scripts`, tidak ada `Makefile`, tidak ada konfigurasi CI. Kalau Anda
membutuhkan lint, itu keputusan baru dan harus ditambahkan sebagai dependensi
dev, bukan diasumsikan sudah ada.

---

## 10. Pengujian

### 10.1 Runner

Tidak ada `package.json` `scripts` dan tidak ada konfigurasi test runner. Yang ada
adalah dua file yang dieksekusi langsung: `tests/logic.mjs` dan
`tests/runtime-smoke.mjs`. Keduanya punya loop sendiri di baris terakhir yang
mencetak hasil per test lalu keluar dengan kode tertentu.

Perhatikan bahwa `node --test tests/` (dengan garis miring, tanpa glob) **gagal
resolve** di Node 24: `Cannot find module .../tests`, exit 1. Bentuk yang bekerja
adalah glob: `node --test "tests/*.mjs"`.

Terukur 2026-10-21: `node tests/logic.mjs` → 37/37 pass exit 0. Terukur
2026-10-20: `node tests/runtime-smoke.mjs` → `STATUS: PROVEN` exit 0 pada host
terisolasi (banner `mode=list-memo`, dua panggilan `list()` nyata,
`list.misses=1`, `list.hits=1`, snapshot tersimpan di DSH_HOME terisolasi).
`node --test` hanya menjalankan berkas pola test-nya, dan berkas repo ini punya
loop masing-masing, jadi bentuk yang dipakai README ini adalah eksekusi langsung.

### 10.2 Cara keberhasilan dilaporkan

Loop di baris terakhir `tests/logic.mjs` memakai pola yang sama:

```javascript
let failed = 0
for (const [label, fn] of tests) {
  try { await fn(); console.log(`PASS ${label}`) }
  catch (error) { failed += 1; console.error(`FAIL ${label}\n  ${error.stack ?? error.message}`) }
}
console.log(failed === 0 ? `ALL ${tests.length} PASS` : `${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
```

Jadi bentuk keberhasilannya:

- Satu baris `PASS <label>` per test.
- Baris penutup `ALL <jumlah> PASS`.
- Kode keluar `0`.

Bentuk kegagalan:

- Baris `FAIL <label>` diikuti stack trace.
- Baris penutup `<jumlah> FAILED`.
- Kode keluar `1`.

`tests/runtime-smoke.mjs` berbeda bentuk: ia bukan suite berlabel, melainkan satu
skrip yang boot host terisolasi lalu mencetak satu status akhir (`STATUS: PROVEN`).
Kalau gagal, ia keluar 1 dengan alasannya, jadi bentuk keberhasilan dan
kegagalannya tetap fail-closed.

### 10.3 Jumlah test

| File | Jumlah test | Cara tahu |
| --- | --- | --- |
| `tests/logic.mjs` | 37 | Dihitung dari 37 pemanggilan `test(...)` di file, per 2026-10-21 |
| `tests/runtime-smoke.mjs` | Bukan suite | Satu skrip: boot host terisolasi, satu status akhir |

Jumlah dihitung dari isi file. Eksekusi terakhir yang tercatat, 2026-10-21:
`node tests/logic.mjs` → `37/37 pass` exit 0. Eksekusi `tests/runtime-smoke.mjs`
terakhir yang tercatat, 2026-10-20: `STATUS: PROVEN` exit 0 (lihat bagian 10.6
untuk apa yang belum terverifikasi).

Suite ini **tidak** membaca atau menulis snapshot hidup. `DSH_HOME` dihapus di
awal berkas (`tests/logic.mjs:137`), karena di lingkungan dev variabel itu
mengarah ke snapshot host yang berisi ribuan header nyata; tes yang menguji
persistensi selalu memakai `snapshotPath` eksplisit di bawah `tmpdir()`.

### 10.4 Jenis test yang ada

**`tests/logic.mjs`, 37 test.** Semua berjalan terhadap service palsu
(`makeFake()` di baris 27) dengan direktori sementara di `tmpdir()` sungguhan.
Kontrak service sekarang mengikuti host 0.2.0-rc.2: yang disediakan `list()`, dan
itu memang yang dibungkus plugin. Kelompoknya:

| Kelompok | Contoh label | Yang diuji |
| --- | --- | --- |
| Mount | `mount: the plugin mounts and memoizes with a persistence that has no inspect` | Regresi kematian diam-diam pada host 0.2.0-rc.2: tanpa `inspect`, plugin tetap mount dan memo tetap bekerja |
| Mount | `mount: a persistence without list() mounts inert but still exposes metrics` | Degradasi jujur: mode `inert`, route tetap terpasang, tidak ada lemparan |
| Mount | `mount: disabled by config leaves no routes` | `enabled: false` benar-benar mematikan plugin |
| List | `list: a second call inside the TTL is served from the memo` | Hit dalam TTL, satu scan untuk dua panggilan |
| List | `list: past the TTL and past the stale window the memo is rescanned` | Scan ulang setelah kedua jendela habis |
| List | `list: past the TTL but inside the stale window the caller is served immediately` | Balas segera + refresh di belakang |
| List | `list: past the stale window the caller waits for a fresh scan` | Setelah jendela stale habis, pemanggil menunggu scan segar |
| List | `list: concurrent calls share one scan` | Penggabungan permintaan bersamaan |
| List | `list: a caller passing {signal}, the real options contract, is served from the memo` | Pemanggil berbawa `{signal}` (kontrak asli host) DILAYANI dari memo; regresi live 15 miss/0 hit |
| List | `list: the caller options bag is forwarded untouched to the host scan` | Argumen pemanggil diteruskan apa adanya ke host |
| List | `list: a pre-aborted caller is not counted (the host never scans)` | Pemanggil yang sudah dibatalkan tidak dihitung |
| List | `list: a pre-aborted caller passing the bare signal is still forwarded (old host shape)` | Bentuk argumen lawas (signal langsung) tetap dikenali |
| List | `list: the memo hands out copies; caller mutation cannot poison it` | Salinan di jalan keluar |
| List | `list: prototype-reaching keys are stripped from the snapshot and its header` | Kunci `__proto__` dan sejenisnya dibuang |
| Snapshot | `snapshot: a young row of session snapshots seeds the first reply without scanning` | Boot dijawab dari snapshot tanpa menunggu scan |
| Snapshot | `snapshot: a completed scan persists real session snapshots, reloadable as a seed` | Baris snapshot benar-benar ditulis ke SQLite dan bisa dibaca lagi |
| Snapshot | `snapshot: a row of flat headers is refused, not served (the live seeding failure)` | Bentuk baris salah ditolak, bukan dilayani |
| Snapshot | `snapshot: a row older than snapshotMaxAgeMs is not served` | Umur divalidasi |
| Snapshot | `snapshot: a row stamped in the future is refused` | Stempel masa depan ditolak |
| Snapshot | `snapshot: rows that are not session snapshots are refused, not served` | Bentuk baris divalidasi sebelum dipercaya |
| Snapshot | `snapshot: a schema version mismatch refuses the row` | Versi skema divalidasi |
| Snapshot | `snapshot: with no snapshotPath nothing is written and list still answers` | Tanpa lokasi: tidak menebak, tidak menulis |
| Snapshot | `snapshot: a failed save is counted and noted, the caller still answers` | Kegagalan tulis terhitung, pemanggil tetap dilayani |
| Snapshot | `snapshot: the serialization runs after the caller already has its reply` | Serialisasi snapshot tidak memblokir reply pemanggil |
| Lifecycle | `lifecycle: a disposed session must not make the next list() wait for a scan` | Pembuangan sesi menandai memo basi, bukan memaksa scan ulang |
| Dispose | `dispose: the plugin removes the row when the host says the session is gone, and the caller is served from memory` | Logika plugin: kalau host menjawab "tidak terdaftar", baris itu dicabut dan pemanggil dilayani dari memori |
| Dispose | `dispose: a session the host still knows keeps its row` | Kalau host masih mengenal sesi itu, barisnya dipertahankan |
| Dispose | `dispose: a persistence without stat() keeps the row and the listener does not throw` | Host tanpa method `stat` tidak membuat listener melempar, dan baris tetap ada |
| Dispose | `dispose: a stat() that rejects keeps the row and never rejects out of the listener` | `stat` yang menolak tidak menghapus baris, tidak membuat listener menolak, dan catatannya tercatat |
| Dispose | `dispose: removing a row keeps the same memo, and the seeded flag and age survive` | Pencabutan satu baris tidak mengganti memo: stempel umur dan penanda `seeded` tetap |
| Dispose | `dispose: a materialized row is kept without asking the host` | Baris yang sudah punya artifact di disk dipertahankan tanpa menanyakan host, karena artifact itu bertahan setelah dispose |
| Dispose | `dispose: a session the memo does not hold does not ask the host` | `stat` hanya dipanggil kalau memo memang memegang baris itu |
| Purge | `purge: the endpoint clears the memo` | Endpoint purge bekerja dan menghitung |
| Config | `config: invalid values fall back to defaults and the route reports them` | Validasi konfigurasi |
| Config | `config: explicit zero TTL with zero stale window rescans every call` | `0` berarti perilaku ketat, bukan error |

**`tests/runtime-smoke.mjs`, skrip integrasi.** Ia memboot host DSH terisolasi
dengan bundle driver sekali-pakai di `tests/driver-plugin/`, memanggil
`sessionPersistence.list()` dua kali, lalu membaca endpoint metrics plugin di
host tersebut. Status akhir yang dicetak: `STATUS: PROVEN` kalau banner mount,
dua panggilan `list()` nyata, hit memo, dan snapshot di disk semuanya benar.
Kalau salah satu tidak terpenuhi, skrip keluar 1 dan menyebut mana yang gagal
(bagian 10.6).

### 10.5 Prasyarat menjalankan tiap test

| Test | Prasyarat | Sumber |
| --- | --- | --- |
| `tests/logic.mjs` | `better-sqlite3` bisa di-import. Test snapshot memakainya langsung lewat `createRequire` (`tests/logic.mjs:5`, `14`, `104`) | Berkas test |
| `tests/runtime-smoke.mjs` | Checkout host di `/home/administrator/deepseek-harness` dengan CLI yang sudah dibangun (`apps/cli/lib/bin.js`); skrip menjalankan `node` pada CLI itu dari checkout host | `tests/runtime-smoke.mjs:33`, `58` |

Kedua file itu dijalankan dengan `node` biasa, jadi `tsx` tidak dibutuhkan. `tsx`
hanya dipakai skrip investigasi lokal di `artifacts/` (folder itu di-ignore, tidak
ikut ter-commit), yang mengimpor decoder zstd milik host secara langsung.

### 10.6 Batasan pengujian yang sudah tercatat

Repo ini sendiri punya catatan jujur tentang apa yang **tidak** teruji. Jangan
lewati bagian ini:

- Semua pengukuran runtime dilakukan pada replika terisolasi, bukan pada proses GUI
  yang sedang berjalan (`SECURITY-AUDIT.md` bagian 7).
- Belum ada bukti eksekusi end-to-end pada jalur subagent: driver di
  `tests/runtime-smoke.mjs` memanggil `sessionPersistence.list()` langsung, bukan
  lewat RPC `session.list` dari klien GUI (`SECURITY-AUDIT.md` bagian 4). RPC GUI
  sendiri berjalan di atas WebSocket `connection`, bukan HTTP POST `/api`, jadi
  pengukur HTTP lama (`smoke-test.mjs`, `measure-e2e.mjs`) sudah dihapus.
- **Validasi store-level yang hanya bisa dilihat dengan scan direktori tetap tidak
  ditiru.** Cache hit memvalidasi berkas artifact-nya, bukan seluruh pojok store.
  Kalau store rusak dengan cara yang hanya terlihat lewat scan (id kembar di dua
  direktori proyek, artifact dengan encoding berlawanan), plugin tetap
  mengembalikan view yang sudah di-cache selama host yang belum ter-cache akan
  menolak. Ini batas desain, bukan cacat baru: menghilangkannya butuh scan penuh,
  yaitu tepat biaya yang cache ini ada untuk menghindari. Batas ini tetap tercatat
  di `SECURITY-AUDIT.md`.
- Invalidasi sesi dibuang bergantung pada event host `session/disposed`. Bila host
  tidak mengirim event itu untuk lifecycle tertentu, invalidasi untuk kasus itu
  tidak terjadi dan view lama bisa dilayani sampai TTL habis atau jendela stale
  habis (batasnya `listTtlMs + listMaxStaleMs`, 30,75 detik dengan default).
  Yang menggerakkan event itu sudah diuji terhadap stack host nyata
  (bukti di `artifacts/verify-h03-race.mjs`), tapi belum terhadap GUI hidup.
  Pencabutan baris yang dibuang bergantung pada `target.stat(id)` milik host:
  pemeriksaan itu asynchronous, jadi baris baru dicabut setelah jawabannya tiba,
  dan pemanggil yang datang selama jendela itu masih bisa melihat barisnya.
  Panjang jendela itu diukur di bagian 7.4.
- `tests/runtime-smoke.mjs` sekarang **fail-closed**: ia keluar 1 dengan alasan
  yang jelas kalau banner mount tidak teramati, child mati lebih dulu, atau probe
  RPC gagal (`tests/runtime-smoke.mjs:24-27`). Versi lama keluar 0 tanpa pernah
  mengamati apa pun; itu sudah diperbaiki. Di lingkungan dev repo ini berkas itu
  keluar 1 karena checkout host yang memuat CLI dari source tidak sinkron dengan
  `lib/` build-nya (`@deepseek-ai/cordis` tidak mengekspor `FiberState`), jadi
  jangan dijadikan bukti perilaku plugin; bukti mount ada di
  `artifacts/probe-mount.mjs` dan `artifacts/verify-h03-race.mjs` yang memasang
  plugin di atas service host nyata.
- Cacat argumen CLI yang sudah diperbaiki: spawn di berkas ini dulu mengirim
  `web --profile web` sekaligus, dan launcher host menolaknya dengan
  `select a profile only once` (`apps/cli/src/args.ts` memperluas token `web`
  menjadi `--profile web`), jadi child mati sebelum boot apa pun. Diperbaiki pada
  2026-10-09; argumen baru diverifikasi lewat parser host sendiri (mode
  `profile`, profil `web`) dan bentuk argv-nya dikunci oleh test regresi di
  `tests/logic.mjs`. Kegagalan `FiberState` di lingkungan ini tetap terpisah dari
  cacat itu.

---

## 11. Pemecahan Masalah

Setiap entri diturunkan dari string error atau kondisi nyata di dalam repo ini.
Tidak ada entri generik.

### 11.1 Plugin tidak muncul di host

Gejala: tidak ada baris `[session-readcache] mounted` di log, dan endpoint metrics
balas 404.

Penyebab yang mungkin, urut dari yang paling mungkin:

| Kemungkinan | Cara memastikan | Perbaikan |
| --- | --- | --- |
| Plugin belum terdaftar di profil web | Cek daftar bundle di `~/.dsh/profiles/web/package.json` | Jalankan perintah add di bagian 3.2 |
| Server berjalan sejak sebelum plugin dipasang | Proses host memuat ESM sekali saja saat boot (`README.md` lama, bagian rebuild) | Restart web server |
| `enabled: false` | Cari di log: `[session-readcache] disabled by config` (`lib/index.js:279-281`) | Ubah `enabled` di `cordis.patch.yml` |
| Baris plugin tidak masuk patch | Bandingkan `package.json` baris dsh.bundle.patch dengan file `cordis.patch.yml` yang aktif di host | Pastikan blok `dsh.bundle.patch` masih menunjuk ke `cordis.patch.yml` |

### 11.2 Endpoint metrics tidak ada padahal plugin mounted

Gejala: baris mount ada, tapi `curl .../metrics` tidak menjawab.

Kode menebak-nebak apa yang terjadi: `lib/index.js:815-823` hanya menulis
peringatan ketika `ctx.webServer === undefined`. Kalau `ctx.webServer` ada tapi
`register` gagal, pesannya berbeda: `[session-readcache] route registration failed:
<pesan>` (`lib/index.js:799`, `805`).

Periksa:

| Yang dicari di log | Arti |
| --- | --- |
| `webServer unavailable; metrics/purge endpoints not exposed` | `ctx.webServer` tidak ada. Plugin tetap berjalan, hanya tanpa endpoint. Ini perilaku yang disengaja. |
| `route registration failed: <pesan>` | Registrasi route ditolak, kemungkinan karena path sudah dipakai. Plugin tetap berjalan tanpa endpoint. |

Perbaikan: tidak ada yang perlu diperbaiki di plugin, karena tidak ada yang berubah
perilaku cache. Kalau endpoint dibutuhkan, perbaiki kondisi `ctx.webServer` di host.

### 11.3 Purge mengembalikan 405

Gejala:

```json
{ "error": "method not allowed; use POST" }
```

Penyebab: purge mengubah state, jadi `GET` sengaja ditolak untuk mencegah
penghapusan cache yang tidak disengaja (`lib/index.js:754-758`).

Perbaikan: pakai `POST`.

```bash
curl -X POST 'http://127.0.0.1:13080/plugin/session-readcache/purge?id=s1'
```

### 11.4 Snapshot tidak pernah terisi

Gejala: `snapshot.seeded` tetap `false` dan `snapshot.path` bernilai `null`.

Baca `snapshot.notes` lebih dulu, karena alasannya selalu ditulis di sana:

| Isi `snapshot.notes` | Penyebab | Perbaikan |
| --- | --- | --- |
| `snapshot row is not a list of session snapshots; rescanning` | Baris snapshot berisi elemen yang bukan snapshot sesi (bukan objek, tanpa `header`, atau `header.id` bukan string) (`lib/index.js`) | Hapus file snapshot, lalu biarkan scan nyata menulis ulang. Kalau baris itu ditulis host sungguhan, laporkan: bentuk keluarannya berubah |
| `snapshot too old (Xs); rescanning` | `saved_at` lebih tua dari `snapshotMaxAgeMs` (`lib/index.js:409`) | Normal. Turunkan `snapshotMaxAgeMs` hanya bila memang ingin menerima data lebih tua |
| `snapshot load failed: <pesan>` | Database gagal dibuka atau dibaca (`lib/index.js:229-231`) | Periksa hak tulis direktori dan keutuhan file |
| `snapshot save failed: unmounted before the snapshot write landed` | Mount sudah dilepas sebelum tulis landing (`lib/index.js:265`) | Normal pada reload. Bukan kegagalan |
| `snapshot save failed: <pesan lain>` | Tulis gagal setelah database terbuka (`lib/index.js:273-274`) | Periksa ruang disk dan izin direktori |

Kalau `snapshot.path` bernilai `null`, persistentinya memang tidak diaktifkan.
Baca bagian 5.3: plugin tidak menebak lokasi, jadi tanpa `snapshotPath`, tanpa
service `dshHomePath`, dan tanpa `DSH_HOME`, tidak ada file yang ditulis.

### 11.5 Memo `list` tidak pernah hit

Gejala: `list.misses` naik terus, `list.hits` tetap `0`.

Tiga penyebab yang bisa dijelaskan oleh kode:

| Penyebab | Kenapa | Cara memastikan |
| --- | --- | --- |
| Interval pemanggil lebih panjang dari TTL | Satu scan memakan detik, sedangkan TTL hanya 5000 ms; memo basi sebelum pemanggil berikutnya datang | Gejala yang benar justru `list.staleServed` naik |
| Ada purge di antaranya | Purge sengaja membuang memo; `session/disposed` tidak lagi membuang memo, hanya menandainya basi | `lifecycle.purgeDrops` naik |
| Mode `inert` | Service host tidak punya `list()`, jadi tidak ada yang dibungkus | `mode` di metrics bernilai `inert` |

Kalau yang Anda cari adalah cache untuk membaca satu sesi (bukan daftar), itu
sekarang milik host: `sessionQuery.observeSession` sudah punya cache sendiri yang
di-key revisi `stat`.

### 11.6 `list.hits` selalu nol

Ini bukan kegagalan. Kalau satu scan `list()` memakan waktu berdetik-detik, memo
5000 ms sudah basi sebelum pemanggil yang memicunya selesai. Gejala yang benar
adalah `list.staleServed` yang naik. Penjelasan yang sama tertulis di komentar
`lib/index.js:23-30`, dan alasannya diukur di
`docs/HOST-TICKET-sessionListMetadata.md`.

Kalau memang butuh hit, naikkan `listTtlMs` lewat konfigurasi. Konsekuensinya,
`list.hits` naik tapi kesegaran data ikut tertunda.

### 11.7 Build modul native gagal

Dua error yang tercatat di README lama repo ini:

```text
EROFS open '/home/administrator/.npm/_cacache/...'
```

```text
ENOENT: no such file or directory, mkdir '/home/administrator/.cache/node-gyp'
```

Penyebab: `$HOME` read-only sehingga npm dan `node-gyp` tidak bisa menulis cache
di lokasi default.

Perbaikan: pakai pasangan pengalihan cache, keduanya wajib dan tidak boleh salah
satu saja:

```bash
npm_config_devdir="$PWD/.npm-cache/node-gyp" npm rebuild better-sqlite3 --cache ./.npm-cache
```

### 11.8 `tests/runtime-smoke.mjs` keluar dengan `STATUS: UNVERIFIED`

Skrip ini fail-closed: setiap kegagalan yang ia deteksi dicetak sebagai
`STATUS: UNVERIFIED: <alasan>` lalu keluar 1. Yang paling sering muncul:

| Pesan | Penyebab | Perbaikan |
| --- | --- | --- |
| `the host child exited early with code N` | CLI host gagal boot. Twenty baris terakhir log boot ikut dicetak | Build ulang CLI host, atau perbaiki modul native yang dimuat host (bagian 11.7) |
| `no mode=list-memo mount banner was observed` | Plugin tidak mount, atau mount tanpa `list()` | Cek baris `[session-readcache] mounted` di log boot; kalau tidak ada, cari error plugin di log yang sama |
| `the host started but printed no URL` | Host hidup tapi tidak mencetak URL web | Host mungkin gagal memuat profil web; jalankan CLI host secara manual dengan perintah yang sama |
| `the in-host driver never finished two list() calls` | Bundle driver di `tests/driver-plugin/` tidak termuat | Pastikan `tests/driver-plugin/` utuh dan `cordis.patch.yml` di sana menunjuk plugin ini |
| `expected exactly one real scan, got N` | Jumlah scan tidak sama dengan yang diharapkan: pemanggil kedua tidak dilayani dari memo | Periksa `listTtlMs`; kalau 0, setiap panggilan memang scan baru |
| `expected exactly one memo hit, got N` | Panggilan kedua tidak kena memo | Sama seperti di atas: TTL dan jendela stale menentukan hit |
| `the snapshot file is empty` / `the snapshot save was never recorded` | Tulis snapshot gagal | Baca `snapshot.notes` di metrics; `better-sqlite3` mungkin gagal dimuat (bagian 5.4) |

### 11.9 Checkout host tidak ada atau CLI-nya belum dibangun

Gejala: `STATUS: UNVERIFIED: the host child exited early with code 1`, atau
`Error: ENOENT ... apps/cli/lib/bin.js`.

Penyebab: `tests/runtime-smoke.mjs` menjalankan
`/home/administrator/deepseek-harness/apps/cli/lib/bin.js` (baris 58) dari
checkout host. Kalau checkout itu tidak ada, atau CLI-nya belum dibangun, file
itu tidak ada.

Perbaikan: bangun CLI host lebih dulu, lalu jalankan ulang skripnya. Skrip ini
tidak butuh `tsx`; ia menjalankan `node` pada file `lib/` yang sudah dibangun.

### 11.10 Sesi yang dibuang masih muncul di daftar sesi

Gejala: sebuah sesi sudah dibuang, tapi barisnya masih terlihat di daftar sesi.

Empat sebab yang mungkin, dan cara membedakannya:

| Yang terlihat | Kenapa | Yang harus dilakukan |
| --- | --- | --- |
| `lifecycle.disposedInvalidations` naik, `lifecycle.disposeRowsRemoved` tetap nol | Pada event dispose, host menjawab dari tracker, jadi tidak ada artifact yang terbukti hilang, jadi baris dipertahankan dan bertahan sampai penyegaran di belakang selesai | Tidak ada. Baris itu hilang sendiri saat penyegaran selesai |
| `snapshot.notes` berisi `dispose: stat failed for <id>: <alasan>` | Host tidak bisa ditanya apakah artifact sesinya masih ada, jadi baris dipertahankan: jawaban "tidak terdaftar" belum terbukti | Baca alasannya. Baris itu tetap dilayani sampai penyegaran di belakang selesai |
| Log sesainya dihapus dari disk, tapi barisnya tetap ada | Log dihapus lewat jalur lain, bukan lewat dispose. API `delete()` milik host tidak memancarkan `session/disposed`, jadi plugin tidak diberi tahu | Tunggu penyegaran di belakang selesai. Endpoint purge memaksa scan ulang, dengan harga scan penuh 12,9 detik di host ini (bagian 7.4) |

Kalau `snapshot.notes` tidak menunjukkan apa-apa dan `disposeRowsRemoved` tetap
nol, itu memang jawaban host: saat dispose datang, host masih men-list sesi itu.

---

## 12. Panduan Pengembangan

### 12.1 Bentuk repositori

Tidak ada `CONTRIBUTING.md`, tidak ada `AGENTS.md` di repo ini, tidak ada
konfigurasi CI, tidak ada `CHANGELOG.md`. Jadi tidak ada aturan workflow yang
ditetapkan repo untuk dirinya sendiri. Yang ada hanyalah komentar di dalam
`lib/index.js` yang sangat teliti menjelaskan alasan di balik tiap keputusan.

### 12.2 Kontrak yang tidak boleh dilanggar

Ada lima kontrak yang disebut berulang kali di `lib/index.js` dan di
`SECURITY-AUDIT.md`. Semuanya tentang tidak merusak host:

| Kontrak | Aturannya | Di mana dijaga |
| --- | --- | --- |
| Cache bersifat advisory | Setiap kegagalan di lapisan cache harus jatuh ke method asli | `try/catch` di sekeliling pemakaian memo dan penulisan snapshot |
| Set faithfully pada pembatalan | Pemanggil yang SUDAH dibatalkan tidak pernah dilayani dari memo dan tidak dihitung (host tidak memindai apa pun); pemanggil yang membawa signal HIDUP dilayani dari memo, karena membatalkan scan tidak membuat balasan dari memori jadi basi. Argumen pertama host adalah OPTIONS BAG `{signal?}`, bukan signal-nya sendiri (`SessionPersistenceListOptions`) | `lib/index.js`, fungsi `list(options)` + `isAbortSignalLike` |
| Bungkus hanya baca | Method tulis, `load`, `prepare`, dan perbaikan tidak dibungkus | Hanya `list` yang di-`defineProperty`, dan hanya kalau method itu ada |
| Invalidasi lifecycle | Sesi yang dibuang membuat memo basi, bukan membuahkannya: pemanggil berikutnya dilayani dari memori dan penyegaran berjalan di belakang. Plugin lalu bertanya ke host apakah artifact sesi itu masih ada di disk, dan mencabut barisnya kalau jawabannya tidak. Plugin bertanya ke host apakah sesi itu masih terdaftar, dan mencabut baris itu kalau host menjawab sesi sudah tidak ada. Baris yang sudah punya artifact dipertahankan tanpa menanyakan host, karena `list()` milik host masih menyebut sesi itu | Listener `session/disposed` di `lib/index.js`: menandai memo basi (`listDirty`), lalu untuk baris yang belum pernah ditulis ke disk memanggil `target.stat(id)` pada service `sessionPersistence` yang sama (helper `invalidateDisposedRow`, pemeriksa `isMaterialized`) |
| Mount tidak boleh mati diam-diam | Kalau method yang akan dibungkus tidak ada, plugin tetap mount, tetap memasang route, dan melaporkan mode `inert` | `mode` di banner dan metrics |

Kontrak invalidasi lifecycle punya satu tambahan dari hardening 2026-10-09.
Sebelumnya entri cache
satu sesi bisa bertahan melewati pembuangan sesi itu, dan karena pemanggil yang
datang tepat setelah `session/disposed` melihat sesi sebagai cold (sudah keluar
dari store) sementara flush terakhir belum mendarat, jalur hit pernah
mengembalikan view yang host sendiri tolak. Bukti sebelum/sesudah terhadap stack
host nyata: `artifacts/h03-before-dispose-fix.out` (11/12 stale) dan
`artifacts/h03-after-dispose-fix.out` (0/12).

Balapan itu ada di jalur `inspect()` per sesi. Host `0.2.0-rc.2` menghapus
`inspect` dari service, jadi jalur itu sudah tidak ada di plugin ini, dan jalur
`list()` tidak bisa menghasilkan balapan yang sama: `list()` hanya mengembalikan
header sesi, dan header (`id`, `createdAt`, `cwd`, `version`, `isSeeded`) tidak
berubah saat flush terakhir mendarat. Yang bisa berubah hanyalah KEBERADAAN
baris itu, dan hanya kalau sesinya belum pernah ditulis ke disk.

Yang dilakukan jalur `list()` sekarang, per kontrak C1 di
`docs/CONTRACT-c1-dispose.md` (disepakati 2026-10-21): `session/disposed`
menandai memo basi, lalu plugin menanyakan host apakah artifact sesi itu masih ada di disk.
Baris yang sudah punya artifact di disk, yaitu baris snapshot host yang membawa
`sizeBytes`, TIDAK ditanyakan ke host dan dipertahankan apa adanya. Itu bukan
shortcut: dispose hanya melepaskan sesi, bukan menghapus lognya, jadi artifact
itu bertahan lebih lama dari sesinya, `list()` milik host masih menyebut sesi
itu, dan baris memo-nya memang benar. Yang ditanyakan hanya baris sesi yang
hidup tapi belum pernah ditulis ke disk, karena baris itulah satu-satunya yang
bisa salah setelah dispose. Kalau `stat` mengembalikan snapshot, host masih
mengenal sesi itu, jadi baris dipertahankan; kalau `stat` mengembalikan
`undefined`, host sudah tidak mengenal sesi itu, dan baris dicabut. Kalau `stat`
menolak atau `target.stat` bukan fungsi, baris juga dipertahankan: ketiadaan
sesi belum terbukti. Memo tetap basi, jadi pemanggil berikutnya dilayani dari
memori dan penyegaran berjalan di belakang; yang bisa dibuang hanya satu baris, bukan
seluruh memo, dan tidak ada scan penuh 12,9 detik (median atas 5.343 log, diukur
2026-10-21, angka dan sumbernya di bagian 7.4) yang harus menunggu pemanggil
berikutnya.

`target.stat(id)` itu method milik host sendiri, bukan dependensi baru:
`SessionPersistence` mendeklarasikan
`abstract stat(id, options?): Promise<SessionPersistenceSnapshot | undefined>`
(checkout host, `packages/session/session-persistence/src/index.ts:200`).

Persempitannya itu yang membuat plugin tidak masuk kelas mahal: `stat()` pada
log generasi lama menghash seluruh korpus, dengan median 1,96 detik di host ini
(bagian 7.4), tapi baris seperti itu tidak pernah ditanyakan, karena baris itu
selalu punya artifact. Kelas mahal itu hilang dari jalur dispose.

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
jawabannya belum tiba. Bukti mekanismenya ada di
`tools/probe-pending-stat.mjs`. Batas itu disengaja dan tertulis di kontrak,
bukan cacat yang disembunyikan.

Bukti lain untuk tidak menunggu scan penuh:
`tools/repro-dispose-stall.mjs` dan
`tools/repro-dispose-stall-real.mjs`.

### 12.3 Alur kerja yang sesuai dengan repo

Tidak ada perintah yang ditetapkan repo, jadi ini adalah alur yang **Inferred**
dari struktur file dan catatan di dalam kode:

1. **Baca dulu test.** Nama test di `tests/logic.mjs` sangat deskriptif dan
   menyatakan perilaku yang harus dipertahankan. Misalnya
   `mount: the plugin mounts and memoizes with a persistence that has no inspect`
   adalah spesifikasi regresi, bukan sekadar pemeriksaan.
2. **Ubah `lib/index.js`.** Hanya ada satu file implementasi.
3. **Jalankan test unit lebih dulu**, karena paling cepat dan paling deterministik:

   ```bash
   node tests/logic.mjs
   ```

4. **Jalankan uji integrasi** kalau perubahan menyentuh jalur mount, route
   metrics, atau snapshot:

   ```bash
   node tests/runtime-smoke.mjs
   ```

5. **Perbarui test kalau kontraknya berubah.** Kalau kontraknya tidak berubah,
   test harus tetap hijau. Kalau sebuah test harus diubah agar hijau, berhenti dan
   pahami dulu mengapa kontraknya mau berubah.
6. **Restart web server untuk memeriksa di host hidup.** Restart adalah tindakan
   pemilik. Gensinya logged oleh
   `docs/superpowers/plans/2026-10-05-session-readcache-extensions.md` bagian
   "Verifikasi akhir".
7. **Baru setelah itu**, periksa metrik di host hidup:

   ```bash
   curl http://127.0.0.1:13080/plugin/session-readcache/metrics
   ```

### 12.4 Cara menambahkan opsi konfigurasi

LANGKAH-langkahnya mengikuti pola yang sudah ada:

1. Tambah kunci ke `DEFAULTS` di `lib/index.js:21-33`, dengan komentar yang
   menjelaskan alasan nilai itu.
2. Baca lewat `readCount` di `lib/index.js:56-62` (menggantikan pakaian
   `positiveInt`/`nonNegativeInt` yang hanya diam-diam jatuh ke default). Daftar
   kunci beserta aturan boleh-nol-nya ada di `countSpecs`, `lib/index.js:289-293`.
3. Tulis ke ringkasan mount di `lib/index.js:824` supaya nilai efektif terlihat
   di log saat boot, dan pastikan nilai tidak valid memicu peringatan
   (`lib/index.js:297`) bukan diam-diam diganti.
4. Tulis ulang nilai yang sama di `cordis.patch.yml` supaya terlihat di konfigurasi.
5. Tambah test di `tests/logic.mjs` yang mengunci perilakunya, termasuk test
   nilai tidak valid (lihat `config: invalid values fall back to defaults and the
   route reports them`).

### 12.5 Peringatan khusus

- **Jangan menambahkan dependensi tanpa alasan yang jelas.** Repo ini punya satu
  dependensi produksi.
- **Jangan menulis ke host.** `docs/HOST-TICKET-sessionListMetadata.md` bagian 5
  menyatakan host punya suntingan lokal dan perubahan plugin di sana akan
  berkonflik saat `git pull`. Semua usulan ke host ditulis sebagai tiket.
- **Jangan mengklaim sesuatu sebagai fakta bila hanya hasil pembacaan kode.**
  `SECURITY-AUDIT.md` dan `docs/HOST-TICKET-sessionListMetadata.md` keduanya
  memakai label `[OBSERVED]`, `[OBSERVED-VERIFIKASI]`, dan "belum ditentukan"
  tepat pada tempatnya. Ikuti gaya itu.

---

## 13. Deployment

### 13.1 Yang didukung repo

Hanya satu jalur: **pasang sebagai plugin pada profil web DSH**. Tidak ada
`Dockerfile`, tidak ada `docker-compose.yml`, tidak ada `k8s/`, tidak ada `fly.toml`,
tidak ada `Procfile`, tidak ada `vercel.json`. Plugin tidak punya proses sendiri,
jadi tidak ada artefak yang bisa dibangun.

### 13.2 Langkah demi langkah

```bash
dsh plugin --profile web add link:/home/administrator/agent-workspace/dsh-custom/plugins/dsh-session-readcache
```

Kemudian restart web server. Server yang berjalan menyimpan modul yang sudah
ter-resolve, jadi plugin baru aktif pada proses berikutnya.

Jika `dsh` tidak menambahkan bundle secara otomatis, tambahkan
`"dsh-session-readcache"` ke `dsh.profile.bundles` di
`~/.dsh/profiles/web/package.json`, lalu restart.

### 13.3 Environment variable produksi

Tidak ada environment variable yang wajib diisi untuk produksi. `DSH_HOME` dibaca
sebagai fallback lokasi snapshot saja (`lib/index.js:361-362`), dan host biasanya
sudah menyediakan service `dshHomePath` yang lebih diprioritaskan.

Nilai konfigurasi produksi lengkap disetel di `cordis.patch.yml`, bukan lewat
environment variable.

### 13.4 Rekomendasi untuk pembaca baru

Gunakan jalur standar di 13.2, karena menambah dependensi ke
`dsh.profile.bundles` secara manual adalah langkah tambahan yang hanya perlu
dilakukan kalau `dsh` gagal menambahkannya. Jalur manual menambah
satu file yang harus disinkronkan secara manual dan bisa tidak sinkron dari profil
yang lain.

### 13.5 Rollback

```bash
dsh plugin --profile web remove dsh-session-readcache
```

Kemudian hapus `"dsh-session-readcache"` dari `dsh.profile.bundles` bila masih
tersisa, dan restart web server.

Rollback bersifat menyeluruh: begitu plugin dilepas, perilaku kembali persis ke
cache milik host sendiri. Tidak ada state yang perlu dibersihkan, karena snapshot
hanya dibaca dan tidak pernah membungkus method tulis.

Kalau hanya ingin menonaktifkan sementara tanpa uninstall, pakai
`enabled: false` di `cordis.patch.yml`. Itu lebih cepat dan bisa dikembalikan
dengan satu baris.

---

## 14. Catatan Keamanan

### 14.1 Apa yang tidak boleh di-commit

`.gitignore` di repo ini sudah menutup semua yang seharusnya ditutup:

```text
artifacts/          # hasil investigasi dan reproduksi
.snapshots/         # salinan baseline
node_modules/       # hasil install
.probe/             # DSH_HOME sekali pakai dari artifacts/verify-livehost.mjs
.npm-cache/         # cache npm dan header node-gyp
better-sqlite3/     # salinan modul native, 27M termasuk hasil build
package.json.backup # salinan package.json sebagai alat rollback
```

Dua di antaranya punya alasan yang dijelaskan di `.gitignore:8-10` dan
`.gitignore:11-14`. Alasan modul native tidak ikut di-commit adalah binaries
spesifik platform tidak layak masuk baseline. Alasan cache dipindah ke dalam
workspace adalah `$HOME` read-only, sehingga instalasi harus menunjuk ke cache
yang bisa ditulis di dalam workspace.

**Perlu dikonfirmasi:** `.gitignore` ini tidak menutup semua kemungkinan. Kalau
Anda membuat file baru, periksa sendiri. Dan ini masih perlu dicatat: `.npm-cache/`
serta `artifacts/live/` memuat salinan log sesi dan konfigurasi host. Keduanya
sudah di-ignore, tapi kalau Anda memindahkan file secara manual, periksa ulang.

### 14.2 Prinsip yang dijaga plugin

Delapan poin berikut diambil dari bagian "Safety" README lama repo ini, dan
seluruhnya punya padanan kode di `lib/index.js`:

| Prinsip | Kenapa penting |
| --- | --- |
| Hanya cold | Array event sesi aktif masih tumbuh. Menyimpannya berarti menyajikan data basi. |
| Pembatalan dihormati | Host menolak pemanggil yang sudah dibatalkan sebagai statement pertama. Cache hit tidak boleh jadi pengecualian. |
| Advisory | Cache adalah pembukuan, bukan kebenaran. Setiap kegagalan jatuh ke method asli. |
| Tidak menulis | Hanya method baca yang dibungkus. |
| Header disalin per pemanggil | Kalau konsumen mengubah header yang dikembalikan, cache dan pemanggil lain tidak boleh ikut rusak. |
| Bisa dibalik | `dispose` menghapus wrapper, dan method asli tetap bisa dipanggil sebagai tembolok. |
| Tidak ada tulis snapshot yatim | Tulis yang mendarat setelah mount dilepas akan memberi `saved_at` yang lebih baru dari isi yang ada di sebelahnya, dan merusak satu-satunya invarian yang diandalkan `snapshotMaxAgeMs`. |
| Snapshot divalidasi bentuknya sebelum dipercaya | `Array.isArray` hanya membuktikan isinya array. Elemen yang bukan header sesi akan dilayani sebagai baris sesi, jadi satu elemen buruk membuat seluruh baris dicurigai. |

### 14.3 Endpoint HTTP

Kedua endpoint di bawah bersifat read-only, kecuali purge yang mengubah state. Yang
penting untuk diketahui:

- Metrics tidak butuh autentikasi tambahan. Autentikasi, kalau ada, sepenuhnya
  milik web server host. `curl` tanpa header apa pun akan menjawab kalau host
  mengizinkan.
- Purge menolak semua metode selain POST dengan 405.
- Kedua route didaftarkan di dalam guard `ctx.inject`, supaya pemasangan ganda
  tidak menabrak error path ganda dari web server (`lib/index.js:716`, `319`).
- Kedua route dilepas saat plugin dilepas (`lib/index.js:827-836`).

Perhatikan konsekuensinya: kalau web server host Anda terbuka ke jaringan tanpa
autentikasi, endpoint purge bisa dihapus dari cache oleh siapa pun yang bisa
mengaksesnya. Pola itu hanya membuang cache, jadi akibatnya adalah pembacaan ulang
dari disk, bukan kerusakan data. Tetap, inilah alasan purge menolak GET.

### 14.4 Rahasia

Tidak ada API key, token, password, atau kredensial di dalam kode, konfigurasi,
maupun dokumen repo ini. Repo tidak pernah membuat koneksi jaringan: satu-satunya
I/O adalah filesystem lokal dan SQLite lokal.

---

## 15. FAQ

**Kenapa `list.hits` tetap nol sementara `list.staleServed` naik?**

Karena itu bentuk yang sehat pada host tempat satu scan `list()` memakan detik.
Memo dengan TTL 5000 ms sudah basi sebelum pemanggil yang memicu scan selesai. Di
dalam jendela stale, hasil terakhir dikembalikan seketika dan satu scan berjalan di
background. Kalau Anda ingin hit, naikkan `listTtlMs`, dengan konsekuensi bahwa
data jadi lebih lama basi.

**Apakah plugin ini mengubah perilaku yang bisa dilihat pengguna?**

Hanya dalam satu hal: reply `list()` bisa sampai `listMaxStaleMs` basi setelah
scan nyata terakhir, atau sampai `snapshotMaxAgeMs + listTtlMs + listMaxStaleMs`
basi setelah seed dari snapshot saat boot. Dengan default yang dikirim, batas
terburuk itu 24 jam + 5000 ms + 120000 ms. `session/disposed` tidak lagi membuang
memo, dan baris sesi yang dibuang bertahan di memo sampai penyegaran di
belakang selesai, seperti sebelum C1: pada event dispose, host masih menjawab
"tidak ada artifact-nya" karena menjawab dari tracker in-memory. Baris hilang lebih awal kalau
host menjawab "tidak ada artifact-nya", dan itu yang terjadi pada host yang menjawab
dari disk. Batas basi untuk sisa isi memo tetap jendela stale itu juga. Sesi
yang sedang aktif tidak pernah disentuh.

**Kenapa SQLite dan bukan file JSON untuk snapshot?**

Penulisan snapshot adalah operasi baca-ubah-tulis pada satu baris. SQLite
menyelesaikannya dengan satu `INSERT OR REPLACE` yang atomik. File JSON akan
butuh tulis ke file sementara, `fsync`, lalu `rename` agar selamat dari proses
yang mati di tengah. Harga yang dibayar: modul native yang terikat pada
ABI Node. Alasannya tercatat di README lama repo ini.

**Kenapa modul native yang gagal dimuat tidak mematikan plugin?**

Karena plugin bersifat advisory. Boot tidak boleh gagal karena cache. Jalur
snapshot di-`try`/`catch` di setiap titik, dan hasilnya dilaporkan di
`snapshot.notes`. Konsekuensinya: kalau `better-sqlite3` hilang, memo `list`
tetap bekerja, dan hanya persistenansi snapshot yang mati.

**Apakah plugin menulis ke log sesi?**

Tidak. Ia hanya membungkus `list`, satu method baca. Penulisan sesi,
`load`, `prepare`, dan perbaikan data tidak pernah dibungkus. Ini disebut di
README lama repo ini sebagai sifat non-committing.

**Bisakah saya menghapus file snapshot dengan tangan?**

Bisa, dan itu aman. Plugin akan menjalankan scan penuh sekali lalu menulis ulang
file itu. Tabelnya dibatasi `CHECK (id = 1)` sehingga isinya tidak akan menumpuk.

**Kenapa `dispose` tidak mengembalikan method asli, melainkan menghapusnya?**

Method asli diikat sekali saat mount, lalu hanya dipakai sebagai jalur tembolok.
`dispose` menghapus properti wrapper dari objek target. Untuk backend yang
mengimplement `list` di prototipe kelas, method prototipe muncul kembali begitu
properti wrapper dihapus. Backend yang menetapkannya sebagai own property akan
kehilangannya setelah dihapus. Batasan ini tercatat di README lama repo ini.

**Bisakah saya menjalankan test tanpa DSH host?**

Bisa, dan sebagian besar memang begitu. `node tests/logic.mjs` memakai service
palsu, hanya butuh `node` dan `better-sqlite3`, dan tidak menyentuh store sesi
yang hidup. `node tests/runtime-smoke.mjs` juga tidak butuh host yang sedang
berjalan: skrip itu memboot CLI host terisolasi sendiri dari checkout host
(`/home/administrator/deepseek-harness`), jadi host hidup tidak perlu dibiarkan
nyala saat menjalankannya. Yang tetap perlu host hidup hanyalah pemeriksaan
manual lewat `curl http://127.0.0.1:13080/plugin/session-readcache/metrics`.

---

## 16. Checklist Akhir

Centang setiap langkah dari mendapat repo sampai memakai plugin.

- [ ] 1. Sudah punya repo di `dsh-custom/plugins/dsh-session-readcache`
- [ ] 2. `node --version` menunjukkan versi yang memenuhi `engines.node` (`>=20`), dan memenuhi `>=22` yang diminta lockfile untuk `better-sqlite3`
- [ ] 3. Sudah di dalam direktori plugin: `cd /home/administrator/agent-workspace/dsh-custom/plugins/dsh-session-readcache`
- [ ] 4. Dependensi terpasang: `pnpm install`
- [ ] 5. Binary modul native ada: `ls -la node_modules/better-sqlite3/prebuilds/`
- [ ] 6. Modul native benar-benar bisa dimuat, dan `LOAD_TEST_OK` muncul dari uji muat di bagian 3.4
- [ ] 7. Plugin terdaftar di profil web: `dsh plugin --profile web add link:/home/administrator/agent-workspace/dsh-custom/plugins/dsh-session-readcache`
- [ ] 8. `"dsh-session-readcache"` ada di `dsh.profile.bundles` di `~/.dsh/profiles/web/package.json`, kalau `dsh` tidak menambahkannya sendiri
- [ ] 9. Web server sudah direstart, dan baris `[session-readcache] mounted (...)` terlihat di log
- [ ] 10. Konfigurasi di `cordis.patch.yml` sesuai kebutuhan, khususnya `listMaxStaleMs` bila kesegaran data lebih penting daripada kecepatan
- [ ] 11. `snapshotPath` sudah ditentukan, atau sudah dipastikan host menyediakan service `dshHomePath` atau `DSH_HOME`
- [ ] 12. Test unit hijau: `node tests/logic.mjs` (output harus `37/37 pass`)
- [ ] 13. Uji host terisolasi hijau: `node tests/runtime-smoke.mjs` (output harus `STATUS: PROVEN`)
- [ ] 14. Endpoint metrics menjawab di host hidup: `curl http://127.0.0.1:13080/plugin/session-readcache/metrics`
- [ ] 15. `mode` di metrics bernilai `list-memo`, dan `snapshot.path` tidak `null`
- [ ] 16. Sudah memakai plugin: beberapa daftar sesi dibuka berulang di GUI, lalu `list.hits` atau `list.staleServed` naik di metrics
- [ ] 17. Rollback sudah diketahui: `dsh plugin --profile web remove dsh-session-readcache`

---

## Lampiran: Catatan Inventaris

Bagian ini adalah catatan kerja yang menjelaskan asal setiap klaim di dokumen ini.
Bukan bagian untuk pembaca umum.

### A.1 Inventaris: ditemukan

| Target | Status | Yang diambil |
| --- | --- | --- |
| `package.json` | ditemukan | Nama, versi `0.1.0`, deskripsi, `type: module`, `main` dan `exports`, `files`, lisensi MIT, `engines.node >=20`, `dsh.engines.dsh >=0.1.1-rc.1`, `dsh.bundle.patch`, satu dependency. **Tidak ada blok `scripts`** |
| `pnpm-lock.yaml` | ditemukan | `lockfileVersion 9.0`, `better-sqlite3@13.0.3` dengan `engines.node >=22`, `node-addon-api@8.9.2` |
| `cordis.patch.yml` | ditemukan | 20 baris. Baris `insert` dengan `id: session-readcache`, `name: dsh-session-readcache`, tiga kunci konfigurasi |
| `lib/index.js` | ditemukan | 838 baris, dibaca per 2026-10-21. `DEFAULTS`, validator konfigurasi, memo `list` dengan TTL/jendela stale/penggabungan permintaan, listener `session/disposed` yang mencabut baris sesi yang belum pernah ditulis ke disk (helper `invalidateDisposedRow`, pembaca id baris `rowId`, pemeriksa `isMaterialized`, counter `disposeRowsRemoved`), pemuatan snapshot SQLite, dua route HTTP |
| `tests/logic.mjs` | ditemukan | 752 baris, dibaca per 2026-10-21. Suite kontrak: 37 test, loop penutup sendiri, exit code fail-closed |
| `tests/runtime-smoke.mjs` | ditemukan | 140 baris. Boot host terisolasi dengan bundle driver sekali-pakai di `tests/driver-plugin/`, fail-closed |
| `tests/driver-plugin/` | ditemukan | 40 baris `lib/index.js`. Bundle driver sekali-pakai: dua panggilan `list()` nyata di dalam host, lalu mencetak baris `[readcache-driver] done` |
| `SECURITY-AUDIT.md` | ditemukan | 192 baris. Bukti reachability, A/B guard, koreksi pengukuran, batas pengujian, butir yang belum tertutup |
| `docs/HOST-TICKET-sessionListMetadata.md` | ditemukan | 234 baris. Tabel evidence berlabel `[OBSERVED]`, koreksi hipotesis awal, usulan fix host, batasan |
| `docs/superpowers/plans/2026-10-05-session-readcache-extensions.md` | ditemukan | 358 baris. Rencana Metrics + integration test, dengan build commands dan expected output |
| `.gitignore` | ditemukan | 16 baris, tujuh entri |
| `PRD.md` | ditemukan | Syarat plugin ini: masalah, persyaratan fungsional dan non-fungsional, batas kesegaran, kriteria penerimaan, keputusan terbuka |
| `README.md` lama | ditemukan | 227 baris. Sumber perintah install, rebuild, dan angka pengukuran |

### A.2 Inventaris: tidak ada

| Target | Status | Dampak ke dokumen |
| --- | --- | --- |
| `LICENSE` | tidak ada | Lisensi hanya diklaim di `package.json`. Tidak diklaim di README. |
| `CONTRIBUTING.md` | tidak ada | Bagian 12 memakai alur **Inferred** dan menyatakan demikian |
| `AGENTS.md` | tidak ada | Tidak ada aturan workflow dari repo |
| `CHANGELOG.md` | tidak ada | Tidak ada |
| `.env.example` | tidak ada | Bagian 3.3 menyatakan tidak ada, hanya menyebut `DSH_HOME` yang terbaca di kode |
| `Makefile`, `Taskfile.yml`, `justfile` | tidak ada | Bagian 9.6 menyatakan tidak ada perintah lint/build |
| `docker-compose.yml`, `Dockerfile`, `compose.yaml` | tidak ada | Bagian 13 menyatakan tidak ada jalur container |
| `vercel.json`, `k8s/`, `fly.toml`, `netlify.toml`, `Procfile` | tidak ada | Bagian 13 sama |
| `.github/workflows/*.yml`, `.gitlab-ci.yml` | tidak ada | Tidak ada kontrak dari CI |
| `.nvmrc`, `.tool-versions` | tidak ada | Versi Node hanya dari `engines` dan lockfile |
| Blok `scripts` di `package.json` | tidak ada | Semua perintah test dijalankan langsung ke berkas |
| `smoke-test.mjs`, `measure-e2e.mjs` | tidak ada (sudah dihapus) | Keduanya pengukur HTTP lama. Jalur RPC GUI berjalan di atas WebSocket, bukan HTTP POST, jadi keduanya tidak lagi berguna. Bagian 3.6 dan 10.6 mencatat penghapusannya; bagian 12.3 langkah 7 memakai `curl` ke endpoint metrics |
| `tests/subagent-signal.mjs`, `tests/realfile.mts` | tidak ada | Keduanya milik jalur `inspect` per sesi yang sudah dihapus bersama host `0.2.0-rc.2`. Yang menggantikannya: `tests/logic.mjs` (37 test kontrak) dan `tests/runtime-smoke.mjs` (boot host terisolasi) |

### A.3 Klasifikasi klaim

**Observed**, dibaca langsung dari file:

- Seluruh isi bagian 4, 5, 7.1, 7.2, 8, 9, 10, 11, 14.
- Semua path yang disebut: `lib/index.js`, `cordis.patch.yml`, `tests/logic.mjs`,
  `tests/runtime-smoke.mjs`, `tests/driver-plugin/`, `docs/...`,
  `SECURITY-AUDIT.md`, `pnpm-lock.yaml`, `.gitignore`.
- Semua nama environment variable: hanya `DSH_HOME`, dari `lib/index.js:361-362` dan
  `tests/runtime-smoke.mjs:57`.
- Semua angka versi: `0.1.0`, `>=20`, `>=0.1.1-rc.1`, `13.0.3`, `8.9.2`, `>=22`.
- Semua string error dan kondisi gagal yang dipakai di bagian 11, semuanya
  ditelusuri ke baris yang disebut.
- Aturan pencabutan baris sesi yang dibuang: listener `session/disposed` dan
  helper `invalidateDisposedRow` di `lib/index.js`, plus tujuh test berlabel
  `dispose:` di `tests/logic.mjs`. Bentuk kontaknya, `SessionPersistence.stat`,
  dibaca dari checkout host, `packages/session/session-persistence/src/index.ts`.
- Port `13080`, dari URL yang dicetak host hidup saat boot
  (`dsh web: http://127.0.0.1:13080/...`). Hostlah yang memilih portnya; repo ini
  hanya memakai apa yang dicetak host.
- Path endpoint metrics dan purge, dari `lib/index.js:720` dan `750`.
- Jumlah test 37, dengan cara hit yang dinyatakan di bagian 10.3.

**Inferred**, ditulis dengan label eksplisit:

- `pnpm install` sebagai perintah install, diturunkan dari keberadaan
  `pnpm-lock.yaml`. Dinyatakan di bagian 3.1 dan 9.1.
- Gabungannya `dsh web --port 13080 --no-open` di bagian 6.1. Flag-flagnya
  observed dari `tests/runtime-smoke.mjs:58`; angka `13080` berasal dari URL yang
  dicetak host hidup, bukan dari default yang diasumsikan repo ini.
- Blok YAML di bagian 4, disusun ulang dari baris `insert` yang ada di
  `cordis.patch.yml` tanpa mengubah nilai.
- Urutan kerja di bagian 12.3, diturunkan dari struktur file dan catatan di
  `docs/superpowers/plans/...` dan `SECURITY-AUDIT.md`.
- Alasan teoretis untuk memakai SQLite dan bukan JSON di bagian 5 dan FAQ,
  disalin dari README lama yang mengatakannya eksplisit.

**Perlu dikonfirmasi**, karena repo tidak menyetelnya:

1. Versi Node yang benar-benar dipakai. Diberi dua syarat yang berbeda oleh
   `engines.node` (`>=20`) dan lockfile (`>=22`). Saya menulis keduanya.
2. Perilaku `pnpm install` pada mesin lain. Repo tidak punya CI yang membuktikan.
3. ~~Konflik versi modul native.~~ **Sudah terjawab oleh pengukuran.** Direktori
   `better-sqlite3/` di root memang berisi salinan `12.4.1`, tapi direktori itu
   di-ignore git dan bukan yang dipakai runtime. `require.resolve('better-sqlite3')`
   menunjuk ke `node_modules/.pnpm/better-sqlite3@13.0.3/...`, dan uji muat
   succeed dengan `sqlite_version: 3.53.4`. Yang dipakai runtime adalah **13.0.3**.
4. Port default milik `dsh web`. Repo ini hanya memuat `13080` karena itulah
   yang dicetak host hidup di mesin ini.
5. Ada atau tidaknya perintah migrasi, seed, atau init di luar yang tercatat.
   Tidak ada yang terlihat, tapi tidak ada yang secara eksplisit menyatakannya
   juga.
6. Kelengkapan `.gitignore`. Tujuh entri yang ada menutup yang jelas-jelas perlu
   ditutup, tapi `.gitignore` tidak ada di repo ini sebagai standar yang lengkap.

### A.4 Verifikasi akhir

1. **Setiap perintah ada di file asli.** Ya untuk perintah yang diambil dari
   `README.md` lama, `cordis.patch.yml`, `tests/logic.mjs`,
   `tests/runtime-smoke.mjs`, atau `docs/superpowers/plans/...`. Tidak ada perintah
   yang saya karang. Pengecualian dua hal yang sudah diberi label: `pnpm install`
   (Inferred dari `pnpm-lock.yaml`) dan gabungan perintah boot di 6.1 (Inferred).
   Perintah `ls .../prebuilds/` di bagian 9.4 dan checklist langkah 5 bukan dari
   README lama: path `build/Release/` di sana tidak ada di host ini, jadi diganti
   ke `prebuilds/` berdasarkan hasil `find` dan `realpath`.
2. **Setiap path ada atau diberi label.** Ya. Semua path diverifikasi ada.
   Untuk path modul native,path yang benar adalah
   `node_modules/better-sqlite3/prebuilds/linux-x64.node`. README lama
   menulis `build/Release/*.node`, tetapi path itu tidak ada di host ini; yang
   dipakai runtime adalah `prebuilds/`, karena `better-sqlite3` 13.x memakai
   prebuild, bukan hasil kompilasi dari source.
3. **Setiap environment variable dari `.env.example`, skema konfigurasi, atau
   kode.** Ya. Hanya ada satu: `DSH_HOME`, dan muncul di `lib/index.js:361-362`.
4. **Setiap port dan URL dari config atau compose.** Ya. `13080` berasal dari dua
   skrip pengukuran. Tidak ada compose file di repo. Path endpoint berasal dari
   `lib/index.js`.
5. **Setiap pernyataan "test gagal begini" cocok dengan jalur error asli.** Ya.
   Semua butir di bagian 11 ditelusuri ke baris kode atau ke string yang tercatat
   di README lama dan `SECURITY-AUDIT.md`.
6. **Urutan bisa diikuti.** Ya. Bagian 3 selesai sebelum bagian 4 dipakai. Tidak
   ada bagian yang bergantung pada bagian yang belum gilirannya. Satu-satunya
   ketergantungan ke belakang adalah bagian 4 Konfigurasi, yang sengaja
   ditulis sebelum bagian 5 karena kedua kunci snapshot dibahas di sana.
7. **Tidak ada secret.** Ya. Tidak ada API key, token, password, atau kredensial
   di dokumen ini maupun di file repo yang dirujuk.
8. **Setiap jumlah test dan jumlah baris di dokumen ini.** Jumlah test 37 dihitung
   dari isi `tests/logic.mjs` per 2026-10-21, dan `node tests/logic.mjs` →
   `37/37 pass` exit 0 dijalankan pada sesi penulisan dokumen ini. Jumlah baris
   `lib/index.js` (838) dan `tests/logic.mjs` (752) dibaca pada momen yang sama.
   Kedua file bergerak pada 2026-10-21, jadi kedua angka itu akan perlu dibaca
   ulang sebelum dipakai sebagai klaim.

### A.5 Perbedaan dari README lama yang perlu Anda ketahui

README lama tidak cuma bahasa campuran, tapi beberapa klaimnya sudah tidak
cocok dengan isi repo. Saya tidak mengulang klaim lama; saya
menulis ulang dari file. Perbedaan yang perlu Anda perhatikan:

| Klaim README lama | Status terhadap file |
| --- | --- |
| "34 unit tests" | Saat penulisan ulang: 41 pemanggilan `test`. Setelah adaptasi kontrak 2026-10-10: 24 test, kontrak baru mengikuti host 0.2.0-rc.2 (`list()` saja). Setelah fix performa 2026-10-20: 28 test. Setelah config 24 jam dan penghapusan kunci inert 2026-10-21: 30 test. Setelah kontrak dispose C1 2026-10-21: 37 test, yaitu 30 test lama ditambah 7 test `dispose:` |
| README lama mengatakan plugin membungkus `inspect()` dan `list()` | Salah untuk host 0.2.0-rc.2: `inspect` sudah tidak ada di service, dan sejak 2026-10-10 plugin hanya membungkus `list()` |
| "versi 12.4.1 dari `github:ZiuChen/better-sqlite3` yang terpin di `ea0d8c7...`" | `package.json` dan `pnpm-lock.yaml` sama-sama menyebut `13.0.3` dari registry. Salinan 12.4.1 ada di direktori `better-sqlite3/` yang di-ignore. |
| "Node host-nya v24.19.0" | Tidak ada file di repo yang mengunci versi Node. Dinyatakan perlu dikonfirmasi. |
| "`.npm-cache/` sudah masuk `.gitignore`" | Benar, `.gitignore:10`. |
| "29 MB native module" | Tidak diverifikasi ulang. Tidak dipakai sebagai klaim di dokumen ini. |
| ukuran binary `better_sqlite3.node` | Tidak diverifikasi ulang. Yang jelas: binary yang dipakai ada di `prebuilds/linux-x64.node`, bukan di `build/Release/` |
| "result ~742 ms menjadi ~8 ms" | Angka tercatat di repo, bukan hasil ukur ulang. Dipakai di bagian 7.4 dengan label. |

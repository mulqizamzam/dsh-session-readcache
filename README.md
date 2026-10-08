# dsh-session-readcache

Cache baca (_read cache_) untuk membuka sesi di DSH.

> Dokumen ini ditulis dari isi file di repository ini. Setiap perintah, path, nama
> environment variable, dan port diberi label sumbernya. Yang tidak bisa diverifikasi
> dari file ditandai **Perlu dikonfirmasi**. Klaim yang hanya hasil pembacaan kode,
> bukan hasil eksekusi pada sesi penulisan dokumen ini, diberi label **Inferred**.

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
sebuah cache baca di depan dua method baca pada service `sessionPersistence` milik
host, yaitu `inspect()` dan `list()`. Plugin ini tidak mengubah kode host sama sekali.

Istilah yang perlu diketahui sebelum lanjut:

| Istilah | Arti |
| --- | --- |
| **Detached (cold) session** | Sesi yang tidak sedang aktif di host. Plugin ini hanya menyimpan cache untuk sesi yang **tidak sedang aktif**, karena event dari sesi aktif berubah terus di memori dan tidak boleh disimpan. |
| **LRU (least-recently-used)** | Algoritma eviction: elemen yang paling lama tidak diakses akan dibuang lebih dulu ketika cache penuh. |
| **stat / revisi file** | Pembacaan metadata file (ukuran, waktu modifikasi, inode). Plugin memakai `stat` sebelum membaca file, sehingga data yang sudah dibaca bisa dicocokkan dengan kondisi file saat ini. |
| **TTL (time to live)** | Lama waktu sebuah hasil cache dianggap masih segar sebelum harus dihitung ulang. |
| **Stale window** | Jendela waktu tambahan setelah TTL habis, ketika hasil lama tetap dikembalikan sementara perhitungan baru berjalan di belakang. |
| **Memo** | Satu nilai yang disimpan sementara supaya perhitungan mahal tidak dilakukan berulang kali dalam waktu dekat. |
| **Coalescing (penggabungan)** | Beberapa permintaan yang datang bersamaan digabung menjadi satu pekerjaan baca yang sama. |
| **Snapshot** | Salinan hasil `list()` terakhir yang ditulis ke disk supaya proses yang baru start tidak perlu menghitung ulang dari nol. |
| **ABI** | _Application Binary Interface_. Modul native (_compiled_) harus cocok dengan versi Node yang memuatnya, jika tidak akan gagal dimuat. |

Yang ditambahkan plugin, semuanya dari `lib/index.js`:

- Cache `inspect` dengan kapasitas lebih besar dari cache bawaan host, divalidasi
  dengan satu `stat` per hit. Sumber nilai default: `lib/index.js:12-26`.
- Memo `list` ber-TTL pendek dengan penggabungan permintaan (_coalescing_) yang
  sedang berjalan.
- Jendela stale untuk `list`, supaya pemanggil tidak menunggu scan yang memakan
  detik-detik.
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
lokasi file snapshot (`lib/index.js:313-316`). Kalau host sudah menyediakan service
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
`lib/index.js:12-26`, dan nilai yang sama ditulis ulang di `cordis.patch.yml`.

| Kunci | Default | Fungsi | Boleh 0? |
| --- | --- | --- | --- |
| `enabled` | `true` | `false` menonaktifkan plugin tanpa uninstall: `apply()` langsung keluar dan tidak membungkus apa pun (`lib/index.js:133-136`) | tidak, nilai selain `false` diperlakukan aktif |
| `maxEntries` | `24` | Kapasitas LRU cache `inspect` | tidak, nilai bukan positive integer akan jatuh ke default (`lib/index.js:137`) |
| `maxTotalEvents` | `250000` | Total anggaran event terparse untuk seluruh entri cache | tidak, lihat `lib/index.js:138` |
| `listTtlMs` | `750` | Selama jendela ini hasil scan `list()` dianggap segar dan dilayani sebagai hit | ya, `0` membuat memo selalu basi (`lib/index.js:139`) |
| `listMaxStaleMs` | `30000` | Setelah TTL habis tapi masih di dalam jendela ini, hasil scan terakhir dikembalikan sambil refresh berjalan di belakang | ya, `0` mempertahankan perilaku TTL ketat (`lib/index.js:140`) |
| `snapshotMaxAgeMs` | `600000` | Umur maksimum snapshot yang boleh mengisi memo saat boot | ya, `0` mematikan boot seeding (`lib/index.js:141`) |
| `snapshotPath` | diturunkan | Lokasi file snapshot SQLite secara eksplisit | string kosong berarti pakai turunan (`lib/index.js:305-307`) |

Contoh bentuk konfigurasi, diambil dari `cordis.patch.yml`:

```yaml
- insert:
    - id: session-readcache
      name: dsh-session-readcache
      config:
        maxEntries: 24
        maxTotalEvents: 250000
        listTtlMs: 750
        listMaxStaleMs: 30000
        snapshotMaxAgeMs: 600000
```

Semua nilai di atas adalah nilai yang benar-benar ada di file, bukan placeholder.
Kalau Anda mengubahnya, pastikan tetap bilangan bulat. Nilai yang bukan bilangan
bulat atau negatif akan diabaikan dan default yang dipakai, kecuali pada
`listTtlMs`, `listMaxStaleMs`, dan `snapshotMaxAgeMs` yang menerima `0` sebagai
nilai bermakna (`lib/index.js:28-34`).

---

## 5. Database / Layanan Eksternal

Repo ini **punya** database: satu file SQLite berisi snapshot satu baris. Tidak ada
layanan eksternal, tidak ada koneksi jaringan, tidak ada kredensial.

### 5.1 Skema tabel

Tabel dibuat otomatis saat database pertama kali dibuka, dengan SQL ini persis
seperti tertulis di `lib/index.js:68-72`:

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
| `saved_at` | INTEGER | Waktu milliseconds (`Date.now()`) saat scan selesai, bukan saat baris ditulis. |
| `headers` | TEXT | Hasil `list()` dalam bentuk JSON. |

### 5.2 Penulisan

Tidak ada perintah migrasi, seed, atau init. Baris ditulis sendiri oleh plugin,
setelah scan `list()` selesai, di luar jalur respons pemanggil
(`lib/index.js:379-389`). Penulisan memakai satu pernyataan
`INSERT OR REPLACE`, jadi penulisan ulang satu baris bersifat atomik dan tidak
membutuhkan tulis-tempel-lalu-rename seperti pada file JSON biasa.

### 5.3 Lokasi file

Kalau `snapshotPath` tidak ditetapkan, plugin mencoba tiga sumber secara berurutan
(`lib/index.js:299-320`):

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
(`lib/index.js:66`).

### 5.4 Yang terjadi kalau database tidak bisa dipakai

Semua kegagalan di jalur snapshot ditangkap dan tidak pernah dilempar ke pemanggil.
Akibatnya plugin tetap berjalan. Failure mode yang tercatat di kode:

| Keadaan | Yang terjadi | Di mana |
| --- | --- | --- |
| `better-sqlite3` gagal di-import | `openDatabase` mengembalikan `{ error }`, tidak melempar | `lib/index.js:57-63` |
| File rusak atau bukan SQLite | Handle ditutup, error dikembalikan | `lib/index.js:76-82` |
| Baris snapshot bukan header sesi | Ditolak, scan nyata dijalankan, dicatat di `snapshot.notes` | `lib/index.js:337-342` |
| Snapshot terlalu tua | Ditolak, scan nyata dijalankan | `lib/index.js:344-347` |
| Tulis snapshot gagal | Dicatat di `snapshot.notes` | `lib/index.js:386-388` |
| Mount sudah dilepas sebelum tulis landing | Ditolak, dicatat | `lib/index.js:118-120` |

Alasan kegagalan selalu terlihat di endpoint metrics pada bagian 7, field
`snapshot.notes`.

### 5.5 Kebersihan data

Indeks `id = 1` membuat tabel self-limiting: satu baris, ditimpa setiap scan.
Tidak ada data kedaluwarsa yang menumpuk. Kalau file snapshot dihapus, plugin akan
menjalankan scan penuh sekali lalu menulis ulang file itu.

---

## 6. Menjalankan Proyek

Repo ini bukan aplikasi mandiri. Ia adalah plugin yang di-host oleh
`dsh web`. Jadi "menjalankan proyek" berarti memasang plugin lalu menyalakan host.

### 6.1 Perintah boot host

Bentuk perintah yang benar dapat diambil dari `tests/runtime-smoke.mjs:33-36`, yang
menjalankan binary CLI host dengan argumen berikut: `web`, `--profile web`,
`--port`, `--no-open`:

```bash
dsh web --profile web --port 13080 --no-open
```

Catatan tentang tiap bagian perintah ini:

- `--profile web` dipakai oleh test smoke, jadi nama profilnya memang `web`
  (`tests/runtime-smoke.mjs:35`).
- `--port 13080` adalah port yang dipakai script pengukuran di repo ini
  (`smoke-test.mjs:18` dan `measure-e2e.mjs:4` menuliskan
  `http://127.0.0.1:13080`). `tests/runtime-smoke.mjs:36` memakai `--port 0`,
  yang berarti OS memilih port sendiri. Kedua bentuk itu valid; angka 13080 bukan
  default yang dipatok plugin.
- `--no-open` mencegah host membuka browser sendiri.

**Perlu dikonfirmasi:** nilai default port milik `dsh web` itu sendiri tidak
settle dari file di repo ini. Repo ini hanya memuat `13080` sebagai konvensi
pengukuran. Jangan menganggap `13080` sebagai default.

### 6.2 Bentuk keberhasilan

Plugin memberi dua tanda bahwa ia benar-benar terpasang:

1. Di stderr atau log host, ada baris mount dengan ringkasan konfigurasi
   (`lib/index.js:545`):

   ```text
   [session-readcache] mounted (maxEntries=24, maxTotalEvents=250000, listTtlMs=750, listMaxStaleMs=30000, snapshotMaxAgeMs=600000)
   ```

   Baris ini ditulis dua kali, sekali ke `process.stderr` dan sekali ke
   `ctx.logger`. String persis yang dicari ada di `tests/runtime-smoke.mjs:51`:
   `out.includes('[session-readcache] mounted')`.

2. Endpoint metrics menjawab dengan JSON. Perintah dan bentuk responsnya ada di
   bagian 7.

Kalau `ctx.webServer` tidak ada, plugin tetap berjalan tanpa endpoint dan mencatat
`[session-readcache] webServer unavailable; metrics/purge endpoints not exposed`
(`lib/index.js:542`). Boot tidak pernah diblokir oleh ketiadaan endpoint.

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

Bentuk responsnya diambil dari handler di `lib/index.js:481-498`:

```json
{
  "inspect": { "hits": 0, "misses": 0, "stale": 0, "liveSkips": 0 },
  "list": { "hits": 0, "misses": 0, "staleServed": 0 },
  "cache": { "entries": 0, "totalCost": 0, "inflight": 0 },
  "snapshot": { "path": null, "seedResolved": false, "seeded": false, "notes": [] }
}
```

Angka nol di atas adalah keadaan awal yang sebenarnya. Semua penghitung
diinisialisasi ke `0` di `lib/index.js:142` dan `listSeed` mulai sebagai
`undefined` (`lib/index.js:298`), yang diterjemahkan ke `seedResolved: false`.

Arti setiap field:

| Field | Arti | Kapan naik |
| --- | --- | --- |
| `inspect.hits` | `inspect(id)` dilayani dari cache | Stat file tidak berubah dan sesi tidak sedang aktif |
| `inspect.misses` | `inspect(id)` membaca ulang dari disk | Entri tidak ada, atau stat tidak cocok |
| `inspect.stale` | Entri dibuang karena file benar-benar berubah | Revisi file beda. **Tidak** naik hanya karena sesi jadi aktif, itu dihitung di `liveSkips` (`lib/index.js:230`) |
| `inspect.liveSkips` | Sesi aktif ditolak untuk disimpan | Sesi sedang aktif, jadi event-nya berubah terus (`lib/index.js:258`) |
| `list.hits` | `list()` dilayani dalam TTL | Umur memo kurang dari `listTtlMs` |
| `list.misses` | Scan direktori nyata dijalankan | Dihitung di dalam memo (`lib/index.js:376`), jadi termasuk scan yang dijalankan untuk mencari path log, bukan cuma pemanggil `list()` |
| `list.staleServed` | Dilayani dari jendela stale | Umur memo antara `listTtlMs` dan `listTtlMs + listMaxStaleMs` (`lib/index.js:432-436`) |
| `cache.entries` | Jumlah entri yang tersimpan | Setelah `inspect` miss yang berhasil di-cache |
| `cache.totalCost` | Total event terparse yang dibebankan | Jumlah `events.length` dari seluruh entri |
| `cache.inflight` | Baca yang sedang digabung | Saat beberapa `inspect(id)` tanpa signal berjalan bersamaan |
| `snapshot.path` | Lokasi file snapshot, `null` bila dimatikan | Dihitung sekali saat mount |
| `snapshot.seedResolved` | Seed boot sudah dicoba | Setelah satu pemanggilan `list()`, apa pun hasilnya |
| `snapshot.seeded` | Memo sedang holds data dari snapshot | True sampai scan nyata berikutnya menggantikannya (`lib/index.js:355`, `493`) |
| `snapshot.notes` | Alasan persistensi snapshot tidak bekerja | Maksimal 5 catatan terakhir (`lib/index.js:494`) |

Penghitung direset setiap restart, karena mereka hidup di dalam closure `apply()`
(`lib/index.js:142`) dan bukan di penyimpanan.

### 7.2 Bersihkan cache satu sesi atau semuanya

```bash
# Bersihkan satu sesi
curl -X POST 'http://127.0.0.1:13080/plugin/session-readcache/purge?id=s1'

# Bersihkan semua entri
curl -X POST 'http://127.0.0.1:13080/plugin/session-readcache/purge'
```

Bentuk responsnya dari `lib/index.js:535`:

```json
{ "purged": 1 }
```

Perilaku yang perlu diketahui:

- Metode selain `POST` ditolak dengan status 405 dan badan
  `{ "error": "method not allowed; use POST" }` (`lib/index.js:503-508`).
- Dengan `?id=`, entri itu dihapus dari cache dan dari daftar in-flight.
  `purged: 1` kalau ditemukan, `0` kalau tidak.
- Tanpa `id`, semua entri dan semua in-flight dikosongkan, dan `purged` berisi
  jumlah entri.
- Pembersihan **tidak** menyentuh memo `list`, dan sengaja mempertahankan memo
  path log yang sudah ketemu, sehingga baca berikutnya tetap melewati scan
  direktori walau view-nya dibaca ulang.
- Pembersihan menaikkan epoch invalidasi. Baca yang sedang berjalan saat itu tidak
  akan memasang view-nya setelah selesai (`lib/index.js:512`, `268`). Menghapus
  `id` yang tidak ada hanya melaporkan `purged: 0` tetapi tetap menaikkan epoch.

### 7.3 Bentuk normal setelah dipakai

Setelah beberapa sesi dibuka dan ditutup ulang di GUI, bentuk yang wajar adalah
`inspect.hits` naik, `inspect.misses` naik lebih lambat, `list.staleServed` naik
sementara `list.hits` tetap dekat nol. Itu bukan tanda kegagalan: kalau satu scan
`list()` memakan detik, memo dengan TTL 750 ms sudah basi sebelum pemanggil yang
memicunya selesai. Bentuk itu justru yang sehat pada host seperti ini, dan
dijelaskan di `lib/index.js:16-22`.

### 7.4 Angka yang tercatat di repo

Angka berikut bukan hasil ukur ulang saat dokumen ini ditulis. Semuanya
direkam di dalam repo, di `README.md` lama dan di
`docs/HOST-TICKET-sessionListMetadata.md`:

| Pengukuran | Angka yang tercatat | Sumber |
| --- | --- | --- |
| Scan `list()` langsung pada korpus 3.847 log | 9.761 ms saat cold | `lib/index.js:47` |
| Scan header serial saat warm | 2.703 - 3.007 ms | `docs/HOST-TICKET-sessionListMetadata.md` bagian 2.1 E2 |
| Scan header 32-way paralel | 1.429 ms | idem, E3 |
| RPC `session.list` yang ditunggu pengguna | 9,0 - 10,2 detik | idem, E4 |
| Buka ulang sesi yang sama, integrasi log nyata | sekitar 742 ms menjadi sekitar 8 ms | `README.md` lama |
| Corpus yang diukur | 3.852 log, 1,68 GB | idem, E1 |

Angka-angka itu diukur pada satu host dan satu titik waktu. Corpus sesi bertambah
terus sehingga hitungan log berbeda antar run (3.847 / 3.852 / 3.853 / 3.864
tercatat di repo). Jangan memperlakukan angka ini sebagai jaminan performa.

---

## 8. Struktur Proyek

Pohon direktori dan fungsi tiap entri. Hanya dua tingkat yang ditampilkan;
`artifacts/` dan `node_modules/` dipangkas karena isinya bukan sumber.

```
dsh-session-readcache/
├── package.json                     # metadata paket, engines, deps, registrasi patch bundle
├── README.md                        # dokumen ini
├── SECURITY-AUDIT.md                # catatan reachability, bukti eksekusi, batas pengujian
├── cordis.patch.yml                 # baris konfigurasi plugin yang disisipkan ke profil Cordis
├── pnpm-lock.yaml                   # kunci dependensi: better-sqlite3 13.0.3 + node-addon-api 8.9.2
├── .gitignore                       # apa yang tidak boleh masuk commit
├── lib/
│   └── index.js                     # SELURUH implementasi plugin
├── tests/
│   ├── logic.mjs                    # 41 unit test terhadap service palsu
│   ├── subagent-signal.mjs          # 8 test jalur AbortSignal
│   └── realfile.mts                 # probe integrasi pada log sesi nyata
├── docs/
│   ├── HOST-TICKET-sessionListMetadata.md   # tiket ke owner host, lengkap dengan koreksi
│   └── superpowers/plans/
│       └── 2026-10-05-session-readcache-extensions.md  # rencana pengembangan A + C
├── smoke-test.mjs                   # uji terhadap host yang sedang hidup di :13080
├── measure-e2e.mjs                  # ukur dampak terhadap host yang sedang hidup
├── better-sqlite3/                  # salinan modul native, di-ignore git
├── artifacts/                       # hasil investigasi, reproduksi, laporan breaker/judge
├── .snapshots/                      # salinan baseline, di-ignore git
└── node_modules/                    # hasil install, di-ignore git
```

File yang akan dibuka pertama oleh pembaca baru, urut dari atas:

1. **`lib/index.js`**. Satu-satunya file implementasi. Mulai dari `DEFAULTS` di
   baris 12-26, lalu `apply()` di baris 132, lalu callback `ctx.inject` di baris
   145. Sisanya adalah implementasi cache.
2. **`cordis.patch.yml`**. Delapan belas baris. Ini yang benar-benar diedit saat
   ingin mengubah perilaku plugin lewat konfigurasi.
3. **`tests/logic.mjs`**. Cara kerja plugin dinyatakan sebagai assertion. Nama test
   sudah sangat deskriptif, jadi test ini bisa dibaca sebagai spesifikasi.

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

```bash
node tests/subagent-signal.mjs
```

```bash
tsx tests/realfile.mts
```

### 9.3 Uji terhadap host yang hidup

```bash
node smoke-test.mjs
```

```bash
node measure-e2e.mjs
```

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
adalah tiga file yang dieksekusi langsung oleh `node` atau `tsx`. Masing-masing
mempunyai loop sendiri di baris terakhir yang mencetak hasil per test lalu keluar
dengan kode tertentu.

Perhatikan bahwa `SECURITY-AUDIT.md` bagian 7 mencatat bahwa
`node --test tests/` keluar dengan kode 1 pada kedua commit karena berkas-berkas
di `tests/` bukan suite `node:test`. Itu perilaku yang sudah diketahui, bukan
regresi.

### 10.2 Cara keberhasilan dilaporkan

Loop di `tests/logic.mjs:778-784` dan `tests/subagent-signal.mjs:139-145` memakai
pola yang sama:

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

`tests/realfile.mts` berbeda bentuk: ia memakai `assert` dari `node:assert/strict`
dan mengakhiri dengan `console.log('ALL PASS')` tanpa kode keluar
eksplisit, jadi kegagalan berupa exception yang tidak tertangani.

### 10.3 Jumlah test

| File | Jumlah test | Cara tahu |
| --- | --- | --- |
| `tests/logic.mjs` | 41 | Dihitung dari 41 pemanggilan `test(...)` di file |
| `tests/subagent-signal.mjs` | 8 | Dihitung dari 8 pemanggilan `test(...)` di file |
| `tests/realfile.mts` | Bukan suite | 5 assertion, tidak punya label test |

Jumlah dihitung dari isi file, bukan dari hasil eksekusi pada sesi penulisan
dokumen ini. Inventaris sesi mencatat hasil eksekusi `ALL 41 PASS`,
`ALL 8 PASS`, dan `ALL PASS` untuk ketiga file itu.

### 10.4 Jenis test yang ada

**`tests/logic.mjs`, 41 test.** Semua berjalan terhadap service palsu
(`makeFake()` di baris 27) dengan file sementara di `tmpdir()` sungguhan, supaya
validasi `stat` benar-benar jalan dan bukan mock. Kelompoknya:

| Kelompok | Contoh label | Yang diuji |
| --- | --- | --- |
| Snapshot | `snapshot: rows that are not session headers are refused, not served` | Bentuk baris snapshot divalidasi sebelum dipercaya |
| Snapshot | `snapshot: a write that lands after unmount is declined, not saved` | Mount yang sudah dilepas menolak tulis, dan tidak meninggalkan baris |
| Snapshot | `snapshot: a persisted list seeds the memo at boot within its age` | Boot dijawab dari snapshot tanpa menunggu scan |
| Snapshot | `snapshot: an expired snapshot is ignored and a real scan runs` | Snapshot-too-old ditolak |
| Snapshot | `snapshot: path comes from the dshHomePath service when config omits it` | Resolusi path default |
| Inspect | `inspect: miss then hit (original called once)` | Cache basics |
| Inspect | `inspect: live sessions are never cached` | Sesi aktif tidak pernah di-cache |
| Inspect | `inspect: LRU evicts oldest beyond maxEntries` | Eviction |
| Inspect | `inspect: a write inside the read window never gets certified by a later stat` | Race antara append dan stat |
| List | `list: TTL caches repeat calls; signal bypasses cache` | TTL dan jalur signal |
| List | `list: past-TTL inside the stale window is served instantly and refreshes behind` | Jendela stale |
| List | `list: listMaxStaleMs 0 keeps strict-TTL behaviour` | `0` berarti tidak ada stale window |
| Purge | `purge: with id removes only that entry` | Endpoint purge |
| Purge | `purge: a read parked on the cache-hit path cannot restore the purged entry` | Interaksi purge dan baca yang sedang menunggu stat |
| Metrics | `metrics: counts inspect hits/misses and list hits/misses` | Bentuk JSON metrics |
| Dispose | `dispose restores original methods` | Unmount mengembalikan method asli |

**`tests/subagent-signal.mjs`, 8 test.** Semua tentang `AbortSignal`, yaitu objek
yang dipakai host untuk meminta pembacaan dihentikan. Berkas ini adalah bukti
eksekusi untuk gap di `SECURITY-AUDIT.md` bagian 4. Kontrak yang dikunci di sini:
panggilan yang membawa signal tidak pernah digabung, sedangkan panggilan tanpa
signal digabung. Test terakhir, `signal: a caller that is already dead pays no
directory scan`, memastikan pemanggil yang sudah dibatalkan tidak membayar scan
direktori.

**`tests/realfile.mts`, probe integrasi.** Ini satu-satunya test yang memakai data
nyata. Yang ia lakukan, semua terlihat di berkasnya sendiri:

- Menemukan `session.jsonl.zstd` terbesar di
  `/home/administrator/agent-workspace/.dsh/sessions` saat runtime
  (`tests/realfile.mts:12-28`). Alasan discovering runtime, bukan id tetap, ada di
  komentar baris 10-11: store itu hidup dan berotasi.
- Menyalin file itu ke direktori sementara.
- Mendekode dengan decoder frame zstd milik host yang diimport dari
  `/home/administrator/deepseek-harness/packages/session/session-persistence-jsonl/src/zstd.ts`
  (`tests/realfile.mts:7`).
- Menguji lima hal: repeat tidak baca ulang, objek hasil yang sama dikembalikan,
  parse nyata memang assertion punya durasi yang bisa diukur, jalur cache di bawah
  20 ms, dan append frame zstd yang valid membatalkan entri cache.

### 10.5 Prasyarat menjalankan tiap test

| Test | Prasyarat | Sumber |
| --- | --- | --- |
| `tests/logic.mjs` | `better-sqlite3` bisa di-import. Test snapshot memakainya langsung lewat `createRequire` (`tests/logic.mjs:16`, `78`) | Berkas test |
| `tests/subagent-signal.mjs` | Hanya `node` | Berkas test |
| `tests/realfile.mts` | `tsx`; checkout host di `/home/administrator/deepseek-harness`; direktori sesi di `/home/administrator/agent-workspace/.dsh/sessions` | `tests/realfile.mts:7` dan `12` |
| `smoke-test.mjs` | Host hidup di `127.0.0.1:13080`. Komentar di `smoke-test.mjs:9` menyatakan asumsi itu eksplisit | Berkas test |
| `measure-e2e.mjs` | Host hidup di `127.0.0.1:13080` | `measure-e2e.mjs:4` |
| `tests/runtime-smoke.mjs` | Checkout host di `/home/administrator/deepseek-harness` | `tests/runtime-smoke.mjs:10` |

`tsx` **bukan** dependensi repo ini. Inventaris sesi mencatat binarynya tersedia di
`/home/administrator/deepseek-harness/node_modules/.bin/tsx`, dari checkout host.
**Perlu dikonfirmasi:** repo ini tidak mendeklarasikan `tsx`, jadi di mesin lain
perintah itu harus diarahkan ke binary tsx yang tersedia, atau `tsx`
dipasang terpisah.

### 10.6 Batasan pengujian yang sudah tercatat

Repo ini sendiri punya catatan jujur tentang apa yang **tidak** teruji. Jangan
lewati bagian ini:

- Semua pengukuran runtime dilakukan pada replika terisolasi, bukan pada proses GUI
  yang sedang berjalan (`SECURITY-AUDIT.md` bagian 7).
- Dua jalur pemanggil `inspect(id, signal)` di
  `packages/subagent/subagent/src/list-children.ts:382` dan `continuation.ts:954`
  baru diuji lewat `tests/logic.mjs` dan `tests/subagent-signal.mjs`. Belum ada
  bukti eksekusi end-to-end di jalur subagent (`SECURITY-AUDIT.md` bagian 4).
- Barrier `waitForRetirement` tidak bisa diamati dari posisi plugin
  (`SECURITY-AUDIT.md` bagian 9).
- `tests/runtime-smoke.mjs` tercatat keluar dengan kode 0 tanpa pernah menjalankan
  subjeknya (`SECURITY-AUDIT.md` bagian 9, butir BUG-6). Perlakukan berkasnya
  sebagai alat investigasi, bukan bukti.

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
| `enabled: false` | Cari di log: `[session-readcache] disabled by config` (`lib/index.js:134`) | Ubah `enabled` di `cordis.patch.yml` |
| Baris plugin tidak masuk patch | Bandingkan `package.json` baris dsh.bundle.patch dengan file `cordis.patch.yml` yang aktif di host | Pastikan blok `dsh.bundle.patch` masih menunjuk ke `cordis.patch.yml` |

### 11.2 Endpoint metrics tidak ada padahal plugin mounted

Gejala: baris mount ada, tapi `curl .../metrics` tidak menjawab.

Kode menebak-nebak apa yang terjadi: `lib/index.js:541-543` hanya menulis
peringatan ketika `ctx.webServer === undefined`. Kalau `ctx.webServer` ada tapi
`register` gagal, pesannya berbeda: `[session-readcache] route registration failed:
<pesan>` (`lib/index.js:539`).

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
penghapusan cache yang tidak disengaja (`lib/index.js:503-508`).

Perbaikan: pakai `POST`.

```bash
curl -X POST 'http://127.0.0.1:13080/plugin/session-readcache/purge?id=s1'
```

### 11.4 Snapshot tidak pernah terisi

Gejala: `snapshot.seeded` tetap `false` dan `snapshot.path` bernilai `null`.

Baca `snapshot.notes` lebih dulu, karena alasannya selalu ditulis di sana:

| Isi `snapshot.notes` | Penyebab | Perbaikan |
| --- | --- | --- |
| `snapshot headers are not session headers; rescanning` | Baris snapshot berisi yang bukan objek header sesi (`lib/index.js:340`) | Hapus file snapshot, lalu biarkan scan nyata menulis ulang |
| `snapshot too old (Xs); rescanning` | `saved_at` lebih tua dari `snapshotMaxAgeMs` (`lib/index.js:345`) | Normal. Turunkan `snapshotMaxAgeMs` hanya bila memang ingin menerima data lebih tua |
| `snapshot load failed: <pesan>` | Database gagal dibuka atau dibaca (`lib/index.js:327`) | Periksa hak tulis direktori dan keutuhan file |
| `snapshot save failed: unmounted before the snapshot write landed` | Mount sudah dilepas sebelum tulis landing (`lib/index.js:119`) | Normal pada reload. Bukan kegagalan |
| `snapshot save failed: <pesan lain>` | Tulis gagal setelah database terbuka (`lib/index.js:387`) | Periksa ruang disk dan izin direktori |

Kalau `snapshot.path` bernilai `null`, persistentinya memang tidak diaktifkan.
Baca bagian 5.3: plugin tidak menebak lokasi, jadi tanpa `snapshotPath`, tanpa
service `dshHomePath`, dan tanpa `DSH_HOME`, tidak ada file yang ditulis.

### 11.5 Cache `inspect` tidak pernah hit

Gejala: `inspect.misses` naik terus, `inspect.hits` tetap `0`.

Empat penyebab yang bisa dijelaskan oleh kode:

| Penyebab | Kenapa | Cara memastikan |
| --- | --- | --- |
| Sesi sedang aktif | Sesi aktif ditolak untuk di-cache demi kebenaran (`lib/index.js:257-260`) | `inspect.liveSkips` naik |
| Tidak ada path log yang bisa ditentukan | Cache butuh path file untuk melakukan stat sebelum baca (`lib/index.js:253`) | `target.locate()` tidak mengembalikan `path` untuk header itu |
| View-nya tidak berasal dari file yang di-stats | Kalau header yang terdaftar dan `meta` yang kembali menunjuk artefak berbeda, tidak ada yang di-cache (`lib/index.js:265-266`) | Bandingkan keduanya |
| Tolak ukuran | Kalau `events.length` melebihi `maxTotalEvents`, tidak ada yang di-cache (`lib/index.js:268`) | Naikkan `maxTotalEvents` |

Perhatikan bahwa `inspect.stale` **tidak** naik karena sesi jadi aktif, itu dihitung
di `liveSkips`.

### 11.6 `list.hits` selalu nol

Ini bukan kegagalan. Kalau satu scan `list()` memakan waktu berdetik-detik, memo
750 ms sudah basi sebelum pemanggil yang memicunya selesai. Gejala yang benar
adalah `list.staleServed` yang naik. Penjelasan yang sama tertulis di komentar
`lib/index.js:16-22`, dan alasannya diukur di
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

### 11.8 `tests/realfile.mts` gagal menemukan file

Gejala:

```text
no session.jsonl.zstd found
```

Penyebab: direktori `/home/administrator/agent-workspace/.dsh/sessions` kosong atau
tidak ada. String itu persis dari `tests/realfile.mts:26`, jadi tidak ada tebakan
lain yang mungkin.

Perbaikan: pastikan ada sesi yang sudah pernah dibuat, atau jalankan probe ini dari
host yang punya store sesi.

### 11.9 `tsx` tidak ditemukan

Gejala: `tsx: command not found`.

Penyebab: `tsx` bukan dependensi repo ini, dan `package.json` tidak punya blok
`scripts` yang memaparkannya.

Perbaikan: arahkan ke binary yang ada di checkout host, sesuai inventaris sesi:

```bash
/home/administrator/deepseek-harness/node_modules/.bin/tsx tests/realfile.mts
```

**Perlu dikonfirmasi:** lokasi `tsx` di luar checkout host tidak ditetapkan oleh
repo ini.

---

## 12. Panduan Pengembangan

### 12.1 Bentuk repositori

Tidak ada `CONTRIBUTING.md`, tidak ada `AGENTS.md` di repo ini, tidak ada
konfigurasi CI, tidak ada `CHANGELOG.md`. Jadi tidak ada aturan workflow yang
ditetapkan repo untuk dirinya sendiri. Yang ada hanyalah komentar di dalam
`lib/index.js` yang sangat teliti menjelaskan alasan di balik tiap keputusan.

### 12.2 Kontrak yang tidak boleh dilanggar

Ada empat kontrak yang disebut berulang kali di `lib/index.js` dan di
`SECURITY-AUDIT.md`. Semuanya tentang tidak merusak host:

| Kontrak | Aturannya | Di mana dijaga |
| --- | --- | --- |
| Cache bersifat advisory | Setiap kegagalan di lapisan cache harus jatuh ke method asli | `lib/index.js:280-282`, `463-465` |
| Hanya cold-only | Sesi yang sedang aktif tidak pernah di-cache, dan setiap jalur cache mengecek ulang sebelum mengembalikan | `lib/index.js:211`, `257-260` |
| Set faithfully pada pembatalan | Pemanggil yang membawa signal tidak pernah digabung, dan signal diperiksa ulang setiap `await` | `lib/index.js:178-181`, `199`, `210` |
| Bungkus hanya cold | Method tulis, `load`, `prepare`, dan perbaikan tidak dibungkus | Hanya `inspect` dan `list` yang di-`defineProperty` (`lib/index.js:468-469`) |

### 12.3 Alur kerja yang sesuai dengan repo

Tidak ada perintah yang ditetapkan repo, jadi ini adalah alur yang **Inferred**
dari struktur file dan catatan di dalam kode:

1. **Baca dulu test.** Nama test di `tests/logic.mjs` sangat deskriptif dan
   menyatakan perilaku yang harus dipertahankan. Misalnya
   `inspect: live sessions are never cached` adalah spesifikasi, bukan sekadar
   pemeriksaan.
2. **Ubah `lib/index.js`.** Hanya ada satu file implementasi.
3. **Jalankan test unit lebih dulu**, karena paling cepat dan paling deterministik:

   ```bash
   node tests/logic.mjs
   node tests/subagent-signal.mjs
   ```

4. **Jalankan probe integrasi** kalau perubahan menyentuh jalur validasi stat:

   ```bash
   tsx tests/realfile.mts
   ```

5. **Perbarui test kalau kontraknya berubah.** Kalau kontraknya tidak berubah,
   test harus tetap hijau. Kalau sebuah test harus diubah agar hijau, berhenti dan
   pahami dulu mengapa kontraknya mau berubah.
6. **Restart web server untuk memeriksa di host hidup.** Restart adalah tindakan
   pemilik. Gensinya logged oleh
   `docs/superpowers/plans/2026-10-05-session-readcache-extensions.md` bagian
   "Verifikasi akhir".
7. **Baru setelah itu**, jalankan uji terhadap host hidup:

   ```bash
   node smoke-test.mjs
   node measure-e2e.mjs
   ```

### 12.4 Cara menambahkan opsi konfigurasi

LANGKAH-langkahnya mengikuti pola yang sudah ada:

1. Tambah kunci ke `DEFAULTS` di `lib/index.js:12-26`, dengan komentar yang
   menjelaskan alasan nilai itu.
2. Baca dengan validator yang sudah ada: `positiveInt` untuk nilai yang harus
   positif, `nonNegativeInt` untuk nilai yang boleh nol (`lib/index.js:28-34`).
3. Tulis ke ringkasan mount di `lib/index.js:544` supaya nilai efektif terlihat
   di log saat boot.
4. Tulis ulang nilai yang sama di `cordis.patch.yml` supaya terlihat di konfigurasi.
5. Tambah test di `tests/logic.mjs` yang mengunci perilakunya.

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
sebagai fallback lokasi snapshot saja (`lib/index.js:313-316`), dan host biasanya
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
  tidak menabrak error path ganda dari web server (`lib/index.js:476-477`).
- Kedua route dilepas saat plugin dilepas (`lib/index.js:552-553`).

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
Memo dengan TTL 750 ms sudah basi sebelum pemanggil yang memicu scan selesai. Di
dalam jendela stale, hasil terakhir dikembalikan seketika dan satu scan berjalan di
background. Kalau Anda ingin hit, naikkan `listTtlMs`, dengan konsekuensi bahwa
data jadi lebih lama basi.

**Apakah plugin ini mengubah perilaku yang bisa dilihat pengguna?**

Hanya dalam satu hal: reply `list()` bisa sampai `listMaxStaleMs` basi setelah
scan nyata terakhir, atau sampai `snapshotMaxAgeMs + listTtlMs + listMaxStaleMs`
basi setelah seed dari snapshot saat boot. Dengan default yang dikirim, batas
terburuk itu 10 menit + 750 ms + 30 detik. Session cold yang dibuka ulang jauh
dalam 24 entri dilayani jauh lebih cepat. Sesi yang sedang aktif tidak pernah
disentuh.

**Kenapa SQLite dan bukan file JSON untuk snapshot?**

Penulisan snapshot adalah operasi baca-ubah-tulis pada satu baris. SQLite
menyelesaikannya dengan satu `INSERT OR REPLACE` yang atomik. File JSON akan
butuh tulis ke file sementara, `fsync`, lalu `rename` agar selamat dari proses
yang mati di tengah. Harga yang dibayar: modul native yang terikat pada
ABI Node. Alasannya tercatat di README lama repo ini.

**Kenapa modul native yang gagal dimuat tidak mematikan plugin?**

Karena plugin bersifat advisory. Boot tidak boleh gagal karena cache. Jalur
snapshot di-`try`/`catch` di setiap titik, dan hasilnya dilaporkan di
`snapshot.notes`. Konsekuensinya: kalau `better-sqlite3` hilang, plugin tetap
mempercepat `inspect`, dan hanya boot seeding yang mati.

**Apakah plugin menulis ke log sesi?**

Tidak. Ia hanya membungkus `inspect` dan `list`, dua method baca. Penulisan sesi,
`load`, `prepare`, dan perbaikan data tidak pernah dibungkus. Ini disebut di
README lama repo ini sebagai sifat non-committing.

**Kenapa `totalCost` tidak bisa dipercaya sebagai jumlah event di cache?**

Karena `totalCost` adalah pembukuan yang di-book, bukan jumlah event nyata. Ada
bukti di `SECURITY-AUDIT.md` bagian 3 dan 6 bahwa pada build pra-perbaikan, delapan
baca konkuren untuk satu id menghasilkan delapan penambahan terhadap satu entri
dan selisih `7 × 5228`. Perbaikan coalescing dan guard-nya membuat pengukuran
kembali nol pada dua lengan uji. Tapi kalau Anda melihat `totalCost` jauh lebih
besar dari jumlah event sebenarnya, itu **Inferred** sebagai bug pembukuan, bukan
cache bermasalah.

**Bisakah saya menghapus file snapshot dengan tangan?**

Bisa, dan itu aman. Plugin akan menjalankan scan penuh sekali lalu menulis ulang
file itu. Tabelnya dibatasi `CHECK (id = 1)` sehingga isinya tidak akan menumpuk.

**Kenapa `dispose` tidak mengembalikan method asli, melainkan menghapusnya?**

Method asli diikat sekali saat mount, lalu hanya dipakai sebagai jalur tembolok.
`dispose` menghapus properti wrapper dari objek target. Untuk backend yang
mengimplement `inspect` dan `list` di prototipe kelas, method prototipe muncul
kembali begitu properti wrapper dihapus. Backend yang menetapkan keduanya sebagai
own property akan kehilangan keduanya setelah dihapus. Batasan ini tercatat di
README lama repo ini.

**Bisakah saya menjalankan test tanpa DSH host?**

Bisa, untuk dua test pertama. `tests/logic.mjs` dan `tests/subagent-signal.mjs`
menggunakan service palsu dan hanya butuh `node` serta `better-sqlite3`. Yang butuh
host hidup adalah `smoke-test.mjs` dan `measure-e2e.mjs`. `tests/realfile.mts`
butuh store sesi dan decoder milik host, tapi tidak butuh host berjalan.

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
- [ ] 12. Test unit hijau: `node tests/logic.mjs` dan `node tests/subagent-signal.mjs`
- [ ] 13. Probe integrasi hijau: `tsx tests/realfile.mts`
- [ ] 14. Uji host hidup hijau: `node smoke-test.mjs`
- [ ] 15. Endpoint metrics menjawab: `curl http://127.0.0.1:13080/plugin/session-readcache/metrics`
- [ ] 16. `snapshot.path` tidak bernilai `null`, dan `snapshot.notes` kosong
- [ ] 17. Sudah memakai plugin: beberapa sesi dibuka dan dibuka ulang di GUI, lalu `inspect.hits` naik di metrics
- [ ] 18. Rollback sudah diketahui: `dsh plugin --profile web remove dsh-session-readcache`

---

## Lampiran: Catatan Inventaris

Bagian ini adalah catatan kerja yang menjelaskan asal setiap klaim di dokumen ini.
Bukan bagian untuk pembaca umum.

### A.1 Inventaris: ditemukan

| Target | Status | Yang diambil |
| --- | --- | --- |
| `package.json` | ditemukan | Nama, versi `0.1.0`, deskripsi, `type: module`, `main` dan `exports`, `files`, lisensi MIT, `engines.node >=20`, `dsh.engines.dsh >=0.1.1-rc.1`, `dsh.bundle.patch`, satu dependency. **Tidak ada blok `scripts`** |
| `pnpm-lock.yaml` | ditemukan | `lockfileVersion 9.0`, `better-sqlite3@13.0.3` dengan `engines.node >=22`, `node-addon-api@8.9.2` |
| `cordis.patch.yml` | ditemukan | 18 baris. Baris `insert` dengan `id: session-readcache`, `name: dsh-session-readcache`, lima kunci konfigurasi |
| `lib/index.js` | ditemukan | 568 baris. `DEFAULTS`, validator, implementasi `inspect` dan `list`, pemuatan snapshot, dua route HTTP, blok dispose |
| `tests/logic.mjs` | ditemukan | 784 baris, 41 pemanggilan `test(...)`, loop penutup |
| `tests/subagent-signal.mjs` | ditemukan | 145 baris, 8 pemanggilan `test(...)` |
| `tests/realfile.mts` | ditemukan | 86 baris, import decoder host, 5 assertion |
| `tests/runtime-smoke.mjs` | ditemukan | 121 baris. Menjalankan binary CLI host dengan flag `web --profile web --port 0 --no-open` |
| `smoke-test.mjs` | ditemukan | 87 baris. `BASE_URL http://127.0.0.1:13080`, RPC `session.list` dan `session.create` |
| `measure-e2e.mjs` | ditemukan | 58 baris. `BASE http://127.0.0.1:13080`, membaca metrics, memanggil `session.history` pada sampel enam id |
| `SECURITY-AUDIT.md` | ditemukan | 184 baris. Bukti reachability, A/B guard, koreksi pengukuran, batas pengujian, butir yang belum ditutup |
| `docs/HOST-TICKET-sessionListMetadata.md` | ditemukan | 234 baris. Tabel evidence berlabel `[OBSERVED]`, koreksi hipotesis awal, usulan fix host, batasan |
| `docs/superpowers/plans/2026-10-05-session-readcache-extensions.md` | ditemukan | 358 baris. Rencana Metrics + integration test, dengan build commands dan expected output |
| `.gitignore` | ditemukan | 16 baris, tujuh entri |
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

### A.3 Klasifikasi klaim

**Observed**, dibaca langsung dari file:

- Seluruh isi bagian 4, 5, 7.1, 7.2, 8, 9, 10, 11, 14.
- Semua path yang disebut: `lib/index.js`, `cordis.patch.yml`, `tests/*.mjs`,
  `tests/realfile.mts`, `docs/...`, `SECURITY-AUDIT.md`, `pnpm-lock.yaml`,
  `.gitignore`, `smoke-test.mjs`, `measure-e2e.mjs`, `tests/runtime-smoke.mjs`.
- Semua nama environment variable: hanya `DSH_HOME`, dari `lib/index.js:313` dan
  `tests/runtime-smoke.mjs:39`.
- Semua angka versi: `0.1.0`, `>=20`, `>=0.1.1-rc.1`, `13.0.3`, `8.9.2`, `>=22`.
- Semua string error dan kondisi gagal yang dipakai di bagian 11, semuanya
  ditelusuri ke baris yang disebut.
- Port `13080`, dari `smoke-test.mjs:18` dan `measure-e2e.mjs:4`.
- Path endpoint metrics dan purge, dari `lib/index.js:480` dan `501`.
- Jumlah test 41 dan 8, dengan cara hit yang dinyatakan di bagian 10.3.

**Inferred**, ditulis dengan label eksplisit:

- `pnpm install` sebagai perintah install, diturunkan dari keberadaan
  `pnpm-lock.yaml`. Dinyatakan di bagian 3.1 dan 9.1.
- Gabungannya `dsh web --profile web --port 13080 --no-open` di bagian 6.1.
  Flag-flagnya observed dari `tests/runtime-smoke.mjs:33-36`; angka `13080` berasal
  dari konvensi pengukuran, bukan default host.
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
4. Lokasi `tsx` di luar checkout host. Repo tidak mendeklarasikannya.
5. Port default milik `dsh web`. Repo ini hanya memuat `13080` sebagai konvensi
   pengukuran.
6. Ada atau tidaknya perintah migrasi, seed, atau init di luar yang tercatat.
   Tidak ada yang terlihat, tapi tidak ada yang secara eksplisit menyatakannya
   juga.
7. Kelengkapan `.gitignore`. Tujuh entri yang ada menutup yang jelas-jelas perlu
   ditutup, tapi `.gitignore` tidak ada di repo ini sebagai standar yang lengkap.

### A.4 Verifikasi akhir

1. **Setiap perintah ada di file asli.** Ya untuk perintah yang diambil dari
   `README.md` lama, `cordis.patch.yml`, `tests/*.mjs`, `smoke-test.mjs`,
   `measure-e2e.mjs`, atau `docs/superpowers/plans/...`. Tidak ada perintah
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
   kode.** Ya. Hanya ada satu: `DSH_HOME`, dan muncul di `lib/index.js:313`.
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

### A.5 Perbedaan dari README lama yang perlu Anda ketahui

README lama tidak cuma bahasa campuran, tapi beberapa klaimnya sudah tidak
cocok dengan isi repo. Saya tidak mengulang klaim lama; saya
menulis ulang dari file. Perbedaan yang perlu Anda perhatikan:

| Klaim README lama | Status terhadap file |
| --- | --- |
| "34 unit tests" | File sekarang punya 41 pemanggilan `test`. |
| "versi 12.4.1 dari `github:ZiuChen/better-sqlite3` yang terpin di `ea0d8c7...`" | `package.json` dan `pnpm-lock.yaml` sama-sama menyebut `13.0.3` dari registry. Salinan 12.4.1 ada di direktori `better-sqlite3/` yang di-ignore. |
| "Node host-nya v24.19.0" | Tidak ada file di repo yang mengunci versi Node. Dinyatakan perlu dikonfirmasi. |
| "`.npm-cache/` sudah masuk `.gitignore`" | Benar, `.gitignore:10`. |
| "29 MB native module" | Tidak diverifikasi ulang. Tidak dipakai sebagai klaim di dokumen ini. |
| ukuran binary `better_sqlite3.node` | Tidak diverifikasi ulang. Yang jelas: binary yang dipakai ada di `prebuilds/linux-x64.node`, bukan di `build/Release/` |
| "result ~742 ms menjadi ~8 ms" | Angka tercatat di repo, bukan hasil ukur ulang. Dipakai di bagian 7.4 dengan label. |

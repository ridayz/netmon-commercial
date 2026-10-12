# NetMon Komersil — Rombak Topologi + Monitoring (design)

Tanggal: 2026-10-12. Status: disetujui lisan per seksi, menunggu review file ini.

## 1. Tujuan
Versi komersil standalone lokal (install di mana, dipakai di situ, ala PRTG):
dashboard + collector jalan di mesin yang sama, topologi + database lokal.
Repo baru dari kanvas kosong (buang layer PU/KIJ/GNS3 preset + DB fault dummy lama).
Nanti pindah server = copy file, dipikirin belakangan.

Sukses = user bisa: bikin layer live|dummy → add device → tarik kabel →
monitoring per-port → discover segmen → restart tetap kesimpen → export/import jalan.

## 2. Non-goals v1
Multi-user/auth, histori DB, SQLite, billing, migrasi otomatis antar server.

## 3. Arsitektur
- `index.html` (kanvas kosong, tanpa data bawaan) + `collector/` (serve static +
  API lama + 1 endpoint baru `GET/POST /api/topo` ↔ `data/topo.json` + `.bak`).
- `start-netmon.bat`: nyalakan collector + buka browser localhost.
- `localStorage` hanya cache fallback. Export/Import JSON tetap (jalur migrasi manual).

## 4. Data
- Layer: `{id, label, type: live|dummy, nodes[], links[], areas[]}`.
  `type` dipilih sekali saat buat layer, 1 layer TIDAK boleh campur.
- Node live: `{id, icon(jenis), label, sub, x, y, ip, db}` + `LIVE[db]={ip,...}`.
  Node dummy: sama minus `ip/db/LIVE`.
- Link: `[fromId, toId, media, portA, portB]` (port boleh kosong di live).
- Add live = pilih jenis perangkat dulu → muncul di kanvas → klik kanan
  rename + edit IP → discover via collector → jadi live (gagal = badge merah,
  node tetap ada biar IP bisa dibetulkan). Tanpa fallback dummy di jalur live.
- Add dummy = form bebas (nama/icon/sub), tanpa IP/discover.

## 5. Editor topologi
- Pasang kabel: klik node asal (atau tombol) → garis hantu ikut mouse →
  klik node tujuan. Live: langsung attach device-ke-device, tanpa wajib pilih
  port (port dicatat otomatis kalau ketahuan). Dummy ala Packet Tracer:
  tiap konek wajib pilih port tiap ujung.
- Edit kabel: klik kabel = popup edit port/hapus; klik kanan kabel = hapus;
  drag ujung kabel = pindah colok. Semua undoable (`snapTopo`/HIST lama).
- Status live: port ujung oper=down → kabel merah + ✕ (reuse `topoSt`/`drawTopo`,
  polling 3 dtk). Sehat = animasi dash bergerak (FO orange / LAN biru,
  kesan transfer data, tanpa label Mbps). DOWN = merah solid tanpa animasi.
- Undo/redo + Rapikan: pakai HIST/`autoLayout` yang ada.

## 6. Dashboard monitoring
- Sidebar kiri = daftar nama perangkat (live, filter layer aktif).
  Klik nama (atau klik node di mini topo, sinkron dua arah) → strip
  port-port muncul DI BAWAH live traffic (main panel), klik port → kartu +
  chart poll `/api/traffic` port itu (3 dtk).
- Atas tetap: kartu DL/UL/latency/loss + grafik + rasio. Bawah chart:
  strip port, lalu mini topologi viewer (render ulang fungsi gambar yang sama,
  tanpa menu edit/drag).
- Monitoring hanya baca layer live. Layer dummy: traffic simulasi seperti
  sekarang (chart dummy + animasi kabel), tidak masuk monitoring.

## 7. Discovery segmen (layer live)
Pakai `localnets` + `netscan` collector yang ada. Hasil langsung list
nama perangkat + IP, centang per baris + select-all → masuk layer live aktif
via `addNodeByIpGo` berurutan.

## 8. Error handling
- Collector mati → banner + topo dari cache tetap bisa dilihat, tombol live nonaktif.
- Discover/add gagal (live) → pesan error, node tidak hilang (bisa betulkan IP).
- `data/topo.json` korup → fallback `.bak`, lalu cache `localStorage`.

## 9. Testing manual (checklist v1)
Buat 1 layer live + 1 dummy → add by jenis + isi IP → discover /24 +
select-all → tarik kabel live (tanpa port) + dummy (dengan port) →
hapus/pindah kabel → undo/redo → rapikan → klik device→port→traffic →
restart collector tetap kesimpen → export/import JSON jalan.

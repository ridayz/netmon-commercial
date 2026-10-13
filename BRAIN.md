# BRAIN — NetMon Router AI (otak projek, selalu diingat AI)

> File ini + AGENTS.md root = memori permanen projek. Setiap sesi baru, AI wajib baca file ini dulu.

## 1. Apa ini
Network Monitoring + Router AI — dashboard monitoring perangkat jaringan + AI diagnosa.
Status: **komersil v2** (topologi dirombak total 2026-10-12/13, branch `commercial-topology` merged ke main `005d74c`).
Repo: `ridayz/netmon-router-ai` (public). Live file: `index.html` (alias `netmon-dummy.html`), single-file, Chart.js via CDN.
Backend: `collector/` (Node :8932, satu repo via git subtree). State topologi: `data/topo.json` (+ backup `.bak` otomatis).
Launcher: `start-netmon.bat` (collector + browser sekali dobel-klik, tanpa scheduled task).

## 2. Gaya visual (wajib dipertahankan)
- Pastel biru awan + putih: `#e0f2fe`, `#bae6fd`, `#7dd3fc`, aksen `#0284c7`, teks `#0c4a6e`.
- Rounded 12–18px, kartu putih border pastel, gaya archify bersih.
- Diagram statis archify: `archify-output/topologi-netmon.html` (9/9 showcase pass, spec sha `2def28…`).

## 3. Fitur (komersil v2 — topologi dirombak)

### 3a. Topologi (rombakan 2026-10-12/13)
1. **Layer bertipe** (live|dummy, tipe DIKUNCI saat create, tidak bisa campur/diubah). Tombol layer dinamis + hapus via ✕, 2x klik = rename.
2. **Add device**: per jenis (icon grid) atau add by IP manual. Node baru selalu di tengah viewport.
3. **Kabel drag** ala draw.io/Packet Tracer: klik kanan node → Pasang kabel → tarik → klik tujuan. Klik kabel = edit/hapus/pindah colok (rewire). LAN biru / FO orange / port down = merah.
4. **Label teks** ala draw.io: klik kanan node → ✎ Edit nama & sub-teks + ukuran font (A-/A/A+). Node bebas di-drag.
5. **Animasi traffic** di kabel (garis bergerak = transfer data).
6. **Discovery segmen**: tab Topologi → 🔍 Discover → pilih /24 → centang (+Pilih semua) → tambah ke layer live aktif. Jalur live ketat: gagal = node merah, TANPA fallback angka karangan.
7. **Persist topologi ke server**: `GET/POST /api/topo` → `data/topo.json` (+ `.bak` otomatis kalau korup). Multi-mesin: copy `data/topo.json`. Export/Import JSON juga ada. Undo/redo + Rapikan.
8. **Remote akses**: klik kanan node → 🖥 Remote. Deteksi port otomatis via `/api/ports?ip=` (22 SSH / 23 Telnet / 80-443 web / 8291 Winbox / 8728 API) → buka HTTPS/HTTP/Telnet/SSH/Winbox. Handler sekali: `scripts\install-remote-handlers.bat`.
9. **Ganti icon**: klik kanan node → select icon (router/switch/swpoe/firewall/internet/ont/olt/ap/pc/server). 📦 Pindah layer, 🗑 hapus.

### 3b. Guard dummy vs live (WAJIB)
- Layer **dummy** = tidak dimonitoring (klik node = pesan "layer dummy"). Tambah bebas, konek kabel pilih port, traffic simulasi + animasi.
- Layer **live** = device asli (ping/SNMP/API). Klik node → monitoring + traffic realtime.
- Dashboard sidebar ikut topologi layer aktif: dummy → "tidak dimonitoring"; live kosong → "tambah device"; live ada isi → daftar device + dot.
- **Kredensial device TIDAK pernah ke server** — `LIVE` map (ip/user/pass/community) HANYA di localStorage browser. `DB` port dibangun ulang dari `ensureNodeDb`/`restoreLive`.

### 3c. Monitoring + AI (warisan, tetap berlaku)
10. Sidebar PILIH PERANGKAT ikut topologi (grup Manage ICTel PU + ICTEL KIJ) + dot status. Klik node = pilih perangkat. Status sinkron dua arah.
11. Kartu DL/UL/latency/loss + grafik realtime + strip port + mini topologi viewer.
12. Layer 1 copper TDR: OPEN/SHORT + estimasi jarak fault + PoE + speed.
13. Layer 1 SFP DDM: TX/RX dBm, redaman = TX−RX, temp/volt/bias, LOS alarm.
14. Error counter: CRC/FCS/collision/flap/last-change.
15. **AI = NOC L2/L3 (2026-10-14)**: dua jalur. **A (plan-based, butuh AI key):** klik kanan device → ⚡ AI Troubleshoot → AI diagnosa + bukti + *rencana fix berlangkah* (whitelist op: iface-enable/disable/flap, queue-set, wifi-set, poe-cycle, conntrack-clear; target dikunci ke device tsb, maks 5 langkah) → user klik Yes + 1 login tulis → eksekusi berurutan via `/api/ai-plan-act` (backup `.rsc` dulu, verifikasi per langkah, rollback otomatis bila gagal) → verifikasi ulang. **B (rule-based, tanpa key):** `/api/diag` keluarkan `fixes[]` berpola (admin-DOWN→enable, err/drop→flap, upload-limit kecil→queue-set, radio DOWN→enable, conntrack>10k→clear) → tombol Yes per fix → tiket via `/api/diag-fix-ticket` (server verifikasi ulang kondisi) → alur approve+login yang sama. Tanpa key: notice sekali per sesi (isi key / lanjut lokal / selalu lokal, anti-spam via localStorage+sessionStorage); key error → fallback B otomatis. Status AI NOC (key/base/model + Cek API + pill) ada di sidebar.
16. Tab 🔔 Log/Alarm: event timestamp + severity + filter + badge + bersihkan. Tabel 📋 Riwayat Downtime.
17. Analyzer lokal `/api/diag` (TANPA AI key) + AI `/api/ai-ask` (butuh key). Progres AI via `/api/ai-progress`. Panel hasil: vonis 🟢/🔴 + bukti + saran + durasi.

## 4. Data fault dummy (ARSIP — skenario lama, sudah tidak dipakai)
> Sejak komersil v2, data dummy dimatikan (non-live tampil "—"/0). Skenario di bawah disimpan cuma sebagai referensi logika diagnosa.
- `ether4-CCTV` = putus-23m (TDR OPEN @23m, PoE 0W) → arahan: PoE cycle + tiket teknisi.
- `ether3-AP` = kabel-jelek (CRC↑, SHORT 41m) → arahan: turun 100M + recabling.
- `sfp1-Fiber` = redaman-tinggi (RX −24.6 dBm) → arahan: bersih konektor + cek bending.
- `sfp1-Uplink` = no-light (RX −40 dBm, LOS) → arahan: tiket fiber, JANGAN flap.
- `ether2-Office` = disabled-human → arahan: enable + catat aktor (satu-satunya yang boleh auto-enable).

## 5. Prinsip AI (kekuatan = diagnosa)
- Korelasi: admin/oper + TDR + DDM + CRC/FCS + flap + PoE + LLDP + syslog + last-change.
- Output: vonis + confidence % + 1 arahan tunggal.
- Layer 1 putus/no-light = INFO + tiket, tidak ada fix remote.
- Auto-enable hanya untuk human-error (port access, catat aktor, ada kill-switch).
- Aturan SFP: RX ≤ −25 dBm kritis; redaman = TX−RX; no-light = jangan flap berulang.
- Roadmap: baseline histori + deteksi anomali pre-DOWN, korelasi multi-port, auto-tiket ke tiket-app + daftar bawaan teknisi.

## 6. Perintah cepat
- Jalanin: dobel-klik `start-netmon.bat` (collector :8932 + browser). Cek `http://localhost:8932/health` dulu kalau ragu.
- Edit kode: `index.html` (UI) / `collector/*.js` (backend) → copy `index.html` → `netmon-dummy.html` + `../netmon-dummy.html` → commit → push `origin main`.
- Verifikasi cepat: node --check tiap JS; ekstrak `<script>` → `node --check`; divdiff (`<div` vs `</div>`) = 0; probe headless mkprobe (action file).
- Tambah fitur topologi: baca dulu `docs/superpowers/plans/2026-10-12-netmon-commercial-topology.md` + spec-nya.
- Diagram archify: edit `archify-output/topologi-netmon.architecture.json` → `validate --quality showcase` → `deliver`.

## 7. Log
- 2026-10-09: dummy dashboard pastel + AI simulasi → repo baru `ridayz/netmon-router-ai`.
- 2026-10-09: +Layer 1 TDR/DDM + full AI-driven (hapus tombol manual) + klik kanan disable.
- 2026-10-09: +Tab Topologi archify-style + icon internet 🌐 + deteksi IP publik.
- 2026-10-10: router jadi vector ala MikroTik pastel (lainnya balik emoji); +Tab 🔔 Log/Alarm (badge + filter + bunyi).
- 2026-10-10: durasi DOWN kecatet (sidebar + status pill live, format Xj/Ym/Zd) + flapping realistis (kabel-jelek/SFP-redaman down-pulih sendiri, sehat blip langka, putus/no-light tetap down) + toggle simulasi di sidebar + alarm DOWN/UP-dengan-durasi.
- 2026-10-10: tabel 📋 Riwayat Downtime di tab Log: kolom Perangkat | DOWN tanggal-jam | UP tanggal-jam | Total down per kejadian | Sebab. Tanpa akumulasi. Baris "masih DOWN ⏳" live.
- 2026-10-10: cek ketimpangan DL:UL = bagian AI diagnosa (berlaku di device mana pun yang UP): indikator rasio live di bawah grafik + vonis "download lancar upload ~0" + arahan telusuri QoS/conntrack/airtime + tiket NOC. Ambang dummy: UL<2M & DL>15M atau rasio>8:1.
- 2026-10-10: layer manual (＋ Layer Baru, hapus via ✕, tombol layer dinamis, 2x klik = rename) + save projek (💾 Save + autosave tiap ubah ke localStorage + 🖼 Export PNG/⬆ Import JSON) + ↩ Reset kembali ke layout pabrik. Klik kanan node: 🔍 AI Cek, ⚡ Diagnosa+Fix, ✎ edit teks, font A-/A/A+, ganti icon, 🗑 hapus. Klik kanan kanvas: ＋ area/perangkat di titik itu. Klik kanan area: rename, font, ukuran, hapus. 2x klik node/area = edit teks langsung.
- 2026-10-09: otak disimpan (AGENTS.md + BRAIN.md, BRAIN di-push).
- 2026-10-10/11: collector live (RouterOS API + SNMP + discover + AI analyzer + progres + panel hasil) — detail di AGENTS.md.
- 2026-10-12: **ROMBAKAN KOMERSIL** mulai (branch `commercial-topology`, spec `docs/superpowers/specs/2026-10-12-netmon-commercial-design.md`, plan 9 task): layer live|dummy dikunci, add-by-jenis/icon-grid, kabel drag+rewire, label teks+font, animasi kabel, mini-topo di dashboard, discover select-all, guard dummy vs live, persist `/api/topo` → `data/topo.json`, banner offline, export PNG, remote launcher (ssh/telnet/winbox/web + `/api/ports`), drag presisi (offset), ping-alive node tanpa SNMP.
- 2026-10-13: review headless (mkprobe) → 3 fix: literal `\n` di log seed, sidebar+strip port tak refresh setelah topo load dari server (syncTopo), health dot cek instan saat load (`98b3d47`). Merge --no-ff ke main (`005d74c`) + push.
- 2026-10-13: dashboard dirombak Grafana-style lalu DI-REVERT ke model lama (user: kartu DL/UL + strip port + mini topo) — commit revert; guard anti-timpa topo dipertahankan (auto-save mengalah kalau server lebih baru; `pingIpNodes` hanya save saat berubah). Topologi lama PU/KIJ (export 10-Okt) di-restore ke server via merge.
- 2026-10-14: AI NOC L2/L3 (plan A+B): sidebar blok AI NOC (key/base/model + Cek API + pill + selalu-lokal), notice key sekali per sesi + fallback lokal otomatis, `/api/diag` keluarkan fixes berpola, `/api/diag-fix-ticket` (verifikasi ulang), `/api/ai-plan-act` (1 login, backup `.rsc`, verify per langkah, rollback), prompt `ai-plan` + whitelist op di `ai.js`, guard anti-timpa topo dipertahankan. Fix UI: TDR+Import dihapus, rename layer ✎, Download/Upload penuh, kabel live-follow, traffic full-width + slider window, anti-glitch render. README komersil + screenshot review/topologi-live-rumah.png + topologi-dummy.png (`551b02d`). netmon-dummy.html disinkron (`02793ff`). AGENTS.md+BRAIN.md di-update. Sisa deferred (ledger SDD): dua-browser last-write-wins, tombol live tidak di-disable saat offline, POST /api/topo tanpa 413/validasi tipe, id Date.now rawan tabrakan.

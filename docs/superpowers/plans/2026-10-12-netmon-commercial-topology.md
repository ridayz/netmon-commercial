# NetMon Komersil Topologi Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bangun NetMon komersil standalone lokal dari kanvas kosong: layer live|dummy eksklusif, editor kabel drag, dashboard monitoring per-port, discovery segmen, persist lokal server.

**Architecture:** Frontend tetap `index.html` single-file (kanvas kosong); `collector/server.js` ikut serve static + endpoint `GET/POST /api/topo` ke `data/topo.json`; semua fitur lama yang dipakai di-reuse (HIST/undo, autoLayout, topoSt/drawTopo, netscan/discover, traffic poll), tidak ada DB/framework baru.

**Tech Stack:** HTML/SVG/JS vanilla + Chart.js CDN, Node http collector (ros.js, snmpq.js), file JSON lokal.

**Spec:** `docs/superpowers/specs/2026-10-12-netmon-commercial-design.md`

## Global Constraints

- 1 layer = 1 tipe (`live` atau `dummy`), dipilih sekali saat buat, tidak bisa campur dan tidak bisa diubah.
- Jalur live TIDAK ada fallback dummy: discover gagal = error + badge merah, node tetap ada.
- Kabel live langsung attach device-ke-device tanpa wajib pilih port; kabel dummy wajib pilih port tiap ujung (Packet Tracer).
- Animasi kabel = dash bergerak saja (FO orange `#fb923c`, LAN biru `#38bdf8`), tanpa label Mbps; DOWN = merah solid + ✕, tanpa animasi.
- Sidebar = daftar nama perangkat; strip port muncul DI BAWAH live traffic (main panel), bukan di sidebar.
- Monitoring hanya baca layer live; dummy = traffic simulasi seperti sekarang.
- Sumber utama = `POST/GET /api/topo` ↔ `data/topo.json` (+`.bak`); `localStorage` hanya cache fallback.
- Gaya pastel dipertahankan; tidak ada dependency baru.

## Review Focus

- IP edit tidak valid (`999.1.1.1`, kosong, duplikat di layer) → ditolak dengan pesan, node tidak rusak.
- `data/topo.json` korup/tidak ada saat server start → fallback `.bak`, lalu cache browser, tetap bisa lihat.
- Collector mati saat dashboard dibuka → banner jelas + tombol live nonaktif, viewer tidak blank.
- Kabel dari node ke dirinya sendiri → ditolak dengan pesan.
- Discovery segmen kosong (0 host) → pesan kosong, tidak ada node dibuat.
- Masing-masing dikunci lewat tes di tugas pemiliknya di bawah.

---

### Task 1: Kanvas kosong + layer eksklusif

**Files:**
- Modify: `index.html` (seed LAYERS pu/kij/gleaf, `DB` fault lama, `GNS3_PRESET` auto-load, `newLayer`, `setLayer`, `renderLayerBtns`)
- Test: manual browser checklist (tidak ada framework tes di repo)

**Interfaces:**
- Consumes: tidak ada (task pertama)
- Produces: `LAYERS = {<key>: {label, type:'live'|'dummy', vb, areas:[], nodes:[], links:[]}}`, `curLayer`, `newLayer()` minta tipe sekali dan mengunci, kanvas kosong dependency untuk Task 2–8.

- [ ] **Step 1: Catat perilaku gagal sekarang**
- [ ] Buka `index.html` via file langsung, catat: layer PU/KIJ muncul + DB fault lama ada. Simpan sebagai baseline di langkah commit.
- [ ] **Step 2: Hapus seed + kunci tipe layer di `index.html`**
- [ ] `newLayer()` prompt nama lalu pilih `live|dummy` (sekali, tersimpan di `LAYERS[key].type`, tidak ada UI ubah tipe). Hapus seed pu/kij, hapus auto-load `GNS3_PRESET.gleaf`, kosongkan `DB` bawaan (pertahankan struktur `DB = {}` + `LIVE = {}`), `renderLayerBtns` tampilkan badge tipe. `setLayer` tidak berasumsi ada pu/kij (fallback layer pertama yang ada, atau state kosong dengan teks ajakan).
- [ ] **Step 3: Verifikasi manual**
- [ ] Run: buka `index.html` fresh (clear localStorage) → kanvas kosong + teks ajakan; buat 1 layer live + 1 dummy → badge tampil → refresh → tetap ada (via localStorage sementara, API di Task 2). Expected: PASS.
- [ ] **Step 4: Commit**
- [ ] `git add index.html && git commit -m "feat: kanvas kosong + layer live|dummy eksklusif"`

### Task 2: Persist lokal server

**Files:**
- Modify: `collector/server.js` (serve static + `GET/POST /api/topo`)
- Modify: `index.html` (`saveTopo`/`loadTopo` via API + fallback localStorage)
- Create: `data/topo.json` (template `{at, cur, layers:{}}`), `data/.gitkeep`
- Modify: `start-netmon.bat` (jalankan collector + buka browser localhost)

**Interfaces:**
- Consumes: struktur `LAYERS` dari Task 1.
- Produces: `GET /api/topo -> {at, cur, layers}`, `POST /api/topo {cur, layers} -> {ok, at}`, dipakai semua task berikutnya.

- [ ] **Step 1: Tambah endpoint + static serve di `collector/server.js`**
- [ ] `GET /api/topo` baca `data/topo.json` (hilang → `{cur:null, layers:{}}`; korup → coba `data/topo.json.bak`, gagal → 500 + pesan). `POST /api/topo` validasi ringan (layers objek, tiap layer punya nodes/links array) lalu tulis `.bak` + file baru. Serve `../index.html` + aset untuk `/`. Port tetap 8932 via `.env`/`PORT`.
- [ ] **Step 2: Alihkan save/load di `index.html`**
- [ ] `saveTopo()` POST ke `/api/topo` (gagal → simpan localStorage + badge offline); saat boot coba API dulu, gagal → localStorage. Bentuk payload sama dengan format export JSON lama (`{at, cur, layers}`) biar export/import Task 9 kompatibel.
- [ ] **Step 3: Verifikasi**
- [ ] Run: `node collector/server.js`, `curl localhost:8932/api/topo`, buat layer di browser, restart server, reload → tetap ada. Matikan server → banner offline + cache tampil. Expected: PASS.
- [ ] **Step 4: Commit**

### Task 3: Add live by jenis + rename/edit IP

**Files:**
- Modify: `index.html` (`addTopoNode`/`addNodeAt`, `topoMenu`, `addNodeByIpGo`, `topoUpgrade`)

**Interfaces:**
- Consumes: layer live dari Task 1, `/api/discover` collector (sudah ada).
- Produces: node live `{id, icon, label, sub, x, y, ip, db}` + `LIVE[db]`, dipakai Task 4/6/7.

- [ ] **Step 1: Tambah by jenis tanpa IP dulu**
- [ ] Di layer live, `＋ Tambah perangkat` = pilih jenis (router/switch/swpoe/firewall/internet/ont/olt/ap/pc/server) → node langsung muncul di kanvas (tanpa discover). Klik kanan node = rename + edit IP (gabung `editTopoText` + `topoUpgrade` jadi satu dialog berurutan).
- [ ] **Step 2: Discover saat IP disimpan**
- [ ] Simpan IP → panggil `/api/discover` (reuse `addNodeByIpGo` tanpa `simAdd` fallback). Sukses → `DB`+`LIVE` terisi, sub jadi `ip • LIVE via`. Gagal → badge merah di node + log error, node tetap ada. Validasi IP format + duplikat per layer (Review Focus #1).
- [ ] **Step 3: Verifikasi**
- [ ] Run: tambah router tanpa IP → muncul; isi IP salah → ditolak; isi 192.168.18.6 benar → jadi live; IP mati → badge merah + bisa betulkan. Expected: PASS.
- [ ] **Step 4: Commit**

### Task 4: Kabel drag + hapus/pindah + undo/redo

**Files:**
- Modify: `index.html` (`drawTopo`, `cableFrom`, `topoMenu`, `HIST`/`snapTopo`, `autoLayout`)

**Interfaces:**
- Consumes: node live/dummy dari Task 1/3.
- Produces: links `[fromId, toId, media, portA, portB]`, dipakai Task 5/6.

- [ ] **Step 1: Ganti prompt berlapis jadi drag**
- [ ] Klik node asal (atau tombol Pasang kabel) → garis hantu ikut mouse → klik node tujuan → selesai. Kabel ke diri sendiri ditolak (Review Focus #4). Live: langsung attach tanpa wajib port (portA/B boleh kosong, dicatat otomatis kalau ketahuan dari `DB`). Dummy: wajib pilih port tiap ujung (dialog sederhana, default `ETH1`/`ETH2`).
- [ ] **Step 2: Edit/hapus/pindah kabel**
- [ ] Klik kabel = popup edit port/hapus; klik kanan kabel = hapus langsung; drag ujung kabel ke node lain = pindah colok. Setiap mutasi panggil `snapTopo()` (undo/redo lama) dan hormati `autoLayout`/Rapikan yang ada.
- [ ] **Step 3: Status merah live**
- [ ] Reuse `topoSt`/`drawTopo`: ujung port oper=down → kabel merah + ✕ (polling 3 dtk yang ada, tanpa fungsi polling baru).
- [ ] **Step 4: Verifikasi**
- [ ] Run: tarik 3 kabel, hapus 1 via klik, pindah 1 via drag, undo 2x + redo 2x, rapikan, matikan 1 port di device asli → kabel merah ≤5 dtk. Expected: PASS.
- [ ] **Step 5: Commit**

### Task 5: Animasi transfer kabel

**Files:**
- Modify: `index.html` (`drawTopo` link render + `<style>`)

**Interfaces:**
- Consumes: links + status dari Task 4.
- Produces: visual saja, tidak ada API.

- [ ] **Step 1: Tambah animasi dash**
- [ ] Link sehat: `stroke-dasharray` + animasi `stroke-dashoffset` CSS (FO `#fb923c`, LAN `#38bdf8`). Link DOWN: merah solid + ✕, tanpa animasi. Tanpa label Mbps. Hormati refresh 3 dtk (jangan restart animasi tiap redraw lebih dari perlu).
- [ ] **Step 2: Verifikasi**
- [ ] Run: buka tab Topologi → kabel sehat bergerak; DOWN-kan 1 port → merah solid diam. Expected: PASS.
- [ ] **Step 3: Commit**

### Task 6: Dashboard monitoring + mini topo

**Files:**
- Modify: `index.html` (tab dash: kartu + chart + strip port baru + svg mini kedua; sidebar filter layer; `pickDev`/`renderIfaces`/polling traffic)

**Interfaces:**
- Consumes: node live + links Task 1/3/4, `/api/traffic` (sudah ada).
- Produces: aliran klik device→port→traffic, dipakai verifikasi akhir.

- [ ] **Step 1: Sidebar + strip port**
- [ ] Sidebar daftar nama perangkat live di layer aktif saja. Klik nama → strip port muncul DI BAWAH live traffic (main panel, daftar + status dot). Klik port → kartu + chart poll `/api/traffic?ip=&iface=` tiap 3 dtk (reuse loop yang ada). Dummy tidak muncul di sidebar.
- [ ] **Step 2: Mini topo viewer**
- [ ] SVG kedua di bawah strip port, render dari layer aktif via fungsi gambar yang sama mode viewer (klik node = pilih device, sinkron dua arah dengan sidebar; tanpa drag/menu edit).
- [ ] **Step 3: Verifikasi**
- [ ] Run: layer live 2 device → klik sidebar → port muncul di bawah chart → klik port → traffic jalan; klik node mini topo → hasil sama; pindah layer dummy → sidebar kosong + pesan. Expected: PASS.
- [ ] **Step 4: Commit**

### Task 7: Discovery segmen select-all

**Files:**
- Modify: `index.html` (`discoverModal`, `discoverScan`, `discoverAdd`)

**Interfaces:**
- Consumes: layer live aktif (Task 1), `addNodeByIpGo` tanpa fallback (Task 3), `/api/localnets|/api/netscan` (sudah ada).
- Produces: node live massal di kanvas.

- [ ] **Step 1: List nama + select-all**
- [ ] Hasil scan tampil nama perangkat + IP + info (reuse `guessIcon`), centang per baris + checkbox select-all. Segmen kosong → pesan kosong, tidak ada node dibuat (Review Focus #5).
- [ ] **Step 2: Tambah berurutan ke layer aktif**
- [ ] Reuse `discoverAdd` berurutan (jeda yang ada) ke layer live aktif; gagal per-IP dicatat di log, tidak menggagalkan sisanya.
- [ ] **Step 3: Verifikasi**
- [ ] Run: scan /24 → select-all → tambah → node muncul; scan ulang → duplikat ditolak/ditandai. Expected: PASS.
- [ ] **Step 4: Commit**

### Task 8: Dummy Packet-Tracer + simulasi

**Files:**
- Modify: `index.html` (jalur dummy: tambah bebas, kabel wajib port Task 4, tick simulasi yang ada)

**Interfaces:**
- Consumes: layer dummy (Task 1), editor kabel (Task 4), animasi (Task 5).
- Produces: dummy lengkap, tidak menyentuh collector.

- [ ] **Step 1: Kunci dummy tanpa collector**
- [ ] Tambah perangkat dummy bebas (nama/icon/sub, tanpa IP). Chart pakai tick simulasi yang ada (jangan panggil `/api/traffic`). Tidak masuk sidebar monitoring Task 6.
- [ ] **Step 2: Verifikasi**
- [ ] Run: layer dummy 3 node + kabel ber-port → animasi + chart simulasi jalan; pastikan tidak ada request `/api/discover|/api/traffic` dari node dummy. Expected: PASS.
- [ ] **Step 3: Commit**

### Task 9: Export/import + banner offline + push repo baru

**Files:**
- Modify: `index.html` (export PNG/JSON, import JSON, banner collector, fallback topo korup)
- Modify: `collector/server.js` (pesan error `/api/topo` korup → `.bak`)
- Create: `README` komersil singkat (install lokal + pindah mesin via copy `data/topo.json`)

**Interfaces:**
- Consumes: semua task.
- Produces: repo siap push baru.

- [ ] **Step 1: Finalisasi migrasi + banner**
- [ ] Export/Import JSON kompatibel format `{at, cur, layers}` (termasuk `type`). Banner collector mati + tombol live nonaktif (Review Focus #3). Topo korup → `.bak` → cache (Review Focus #2).
- [ ] **Step 2: Verifikasi akhir (checklist spec §9)**
- [ ] Run: buat live+dummy → add + IP → discover → kabel live/dummy → hapus/pindah → undo/redo → rapikan → device→port→traffic → restart tetap → export/import jalan. Expected: PASS semua.
- [ ] **Step 3: Commit + push repo baru**
- [ ] Run: `git remote -v` (konfirmasi remote baru dari user sebelum push), `git push -u <remote-baru> main`. Jangan push ke `ridayz/netmon-router-ai` uji coba. Expected: remote baru terisi.

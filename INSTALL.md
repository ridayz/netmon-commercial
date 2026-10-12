# Tutorial Pasang Netmon - Router AI

Buat kamu yang ambil repo ini. Butuh: **Windows + Node.js 18+** (cek: `node --version`) dan browser Chrome/Edge.

## 1. Clone + install

```bat
git clone https://github.com/ridayz/netmon-router-ai.git
cd netmon-router-ai
cd collector
npm install
cd ..
```

Yang diinstall cuma 1 package (`net-snmp`, buat baca SNMP).

## 2. Setting collector (`.env`, dibaca otomatis pas start)

```bat
cd collector
copy .env.example .env
```

```bat
cd collector
copy .env.example .env
```

Buka `.env` pakai notepad, isi yang perlu:

| Isi | Wajib? | Buat apa |
|---|---|---|
| `ROS_USER` / `ROS_PASS` | Kalau mau baca MikroTik via API | User read-only di router |
| `SNMP_COMMUNITY` | Kalau mau baca AP/switch via SNMP | Community yang sama dengan di device |
| `AI_KEY` / `AI_BASE_URL` / `AI_MODEL` | Kalau mau tombol ⚡ AI Troubleshoot | Key 9Router / Agnes / OpenAI-compatible |
| `W_USER` / `W_PASS` | Opsional (bisa isi pas klik Setujui) | User tulis di router |

Tanpa isi apa-apa pun jalan — cuma datanya simulasi/dummy sampai device dihubungkan.

## 3. Siapin device-nya

**MikroTik (Winbox/SSH, sekali aja):**
```
/user group add name=mon-read policy=read,api
/user add name=netmon group=mon-read password=netmon123
/ip service set api disabled=no
```

**AP Ruijie / switch (eWeb):** nyalakan SNMP v2c, community samain dengan `.env` (misal `netmon`), manager IP = IP laptop yang jalanin collector.

## 4. Jalanin

Dobel-klik **`start-netmon.bat`** → collector nyala + dashboard kebuka. Atau manual:

```bat
cd collector
node server.js
```

terus buka `index.html` di browser. Titik **COLLECTOR harus 🟢** (pojok kiri). Kalau 🔴 merah = collector belum jalan.

## 5. Pakai

1. Tab **Topologi** → **🔍 Discover** → pilih subnet laptop → Scan → centang → tambah ke layer.
2. Node **🟢** = live (data asli). Node ⚪ = belum live (klik kanan → **⬆ Jadikan live**).
3. Klik node → grafik traffic realtime + status port.
4. Klik kanan → **🔍 Cek device** (analyzer lokal, gratis) / **⚡ AI Troubleshoot** (butuh AI key, bisa eksekusi + minta login).

## Bermasalah?

| Gejala | Obat |
|---|---|
| Collector 🔴 | `cd collector` → `node server.js`, lihat error-nya |
| `EADDRINUSE :8932` | collector dobel — kill node yang pegang port, jalanin sekali aja |
| Discover kosong | Pastikan se-jaringan (WiFi/LAN sama), firewall bolehin ping |
| SNMP ✓ nggak muncul | Community beda / SNMP mati di device |
| AI "invalid key" | Klik **Cek API** di sidebar, baca pesannya |
| Grafik flat 0 | Wajar kalau device ⚪ dummy — live-kan dulu |

Topologi kesimpen otomatis di browser. Backup via tombol **⬇ JSON**, balikin via **⬆ Import**.

# netmon-collector

Jembatan dashboard NetMon Router AI <-> perangkat asli. Jalan di server NOC/PU (atau laptop buat tes).

## Jalanin
```bash
npm install
cp .env.example .env   # isi kredensial asli di .env (JANGAN commit)
node server.js         # :8932
```

## Endpoints (semua balikin JSON)
- `GET /health`
- `GET /api/discover?ip=&user=&pass=&community=` — identitas + daftar interface (coba RouterOS API dulu, fallback SNMP v2c)
- `GET /api/traffic?ip=&iface=&user=&pass=` — rx/tx Mbps realtime (poll 2x, 1 dtk)
- `GET /api/dhcp?ip=&user=&pass=` — pool usage (RouterOS)
- `GET /api/conntrack?ip=&user=&pass=` — tracking + jumlah koneksi (RouterOS)

Query `user/pass/community` opsional — kalau kosong pakai `.env`.

## Butuh di MikroTik
```
/user group add name=mon-api policy=api,read
/user add name=netmon group=mon-api password=XXXX
/ip service set api disabled=no
```

## Status
- 2026-10-10: tembus 192.168.18.6 (DONCUL-HOME, hEX/RB750Gr3, ROS 6.49.11) via API (user netmon) DAN SNMP v2c (community `netmon`, khusus 192.168.18.0/24, di-setup via API). Fallback API->SNMP verified.

// ai.js — panggil model AI apa pun yang ngomong OpenAI-chat (/chat/completions).
async function aiAsk({ baseURL, key, model, messages, timeoutMs = 45000 }) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(baseURL.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) },
      body: JSON.stringify({ model, messages, temperature: 0.3 }),
      signal: ctl.signal,
    });
    // 9Router kadang nambah baris "data: [DONE]" setelah JSON → ambil objek JSON-nya saja
    const txt = await r.text();
    let j = {};
    try { j = JSON.parse(txt); } catch { const m = txt.match(/\{[\s\S]*\}/); try { if (m) j = JSON.parse(m[0]); } catch {} }
    if (!r.ok) throw new Error((j.error && (j.error.message || j.error.code)) || ('AI error ' + r.status));
    const c = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (!c) throw new Error('AI balas kosong');
    return c;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('AI timeout (>' + Math.round(timeoutMs / 1000) + 's) — provider lambat atau model overload, coba lagi');
    throw e;
  } finally { clearTimeout(to); }
}

const AI_SYSTEM = `Kamu teknisi NOC bernama NetMon AI. Gaya santai sopan bahasa Indonesia (kayak ngobrol sama temen), tapi teknis dan akurat.
Aturan:
- Fokus ke device yang sedang terbuka (ada di konteks). Pakai DATA LIVE ROUTER untuk cek status, traffic, CPU, RAM, dan error. Jangan ngarang angka yang tidak ada di konteks.
- Kamu bisa menganalisis semua interface dan konfigurasi yang dikirim. Kalau user minta konfigurasi, tulis langkah RouterOS yang tepat (command lengkap) dan jelaskan dampaknya.
- Kamu TIDAK mengeksekusi perubahan sendiri. Kalau user minta ubah config, usulkan dengan blok persis begini (satu blok per perubahan):
\`\`\`ros-cmd
{"label":"ringkasan singkat","path":"/ip/dns/","args":{"servers":"8.8.8.8,1.1.1.1"}}
\`\`\`
  Dilarang mengusulkan path user, reset, atau reboot. Args sesuai API RouterOS (contoh untuk set: kunci atribut, misal "disabled":"no" atau "numbers":"ether3"). Usulan hanya jadi tiket, user harus setujui dulu. Jangan klaim sudah dikerjakan.
- Jelaskan dampak perubahan sebelum mengusulkannya, terutama yang bisa memutus koneksi.
- Jawab singkat dan to-the-point. Format: vonis dulu (1-2 baris), lalu bukti (poin-poin dari data), lalu saran. Tanpa basa-basi pembuka.
- Kamu ANALYZER: tidak pernah minta password ke user (aplikasi yang minta login tulis saat eksekusi). Kalau diminta VERIFIKASI: beres → tulis DONE di baris pertama; belum → tulis yang masih salah + usulan baru.`;

function buildMessages(message, ctx) {
  const c = ctx || {};
  const dev = c.selected || '?';
  const ifs = (c.device || []).map(x => `- ${x.n} [${x.type}] admin:${x.admin} oper:${x.oper} fault:${x.fault}${x.speed && x.speed !== '-' ? ' ' + x.speed : ''}${x.dl != null ? ' DL:' + x.dl : ''}${x.ul != null ? ' UL:' + x.ul : ''}`).join('\n');
  const lv = c.live ? `LIVE dari ${c.live.identity || '?'} (${c.live.ip}):\n` + (c.live.ifaces || []).map(i => `- ${i.n} admin:${i.admin} oper:${i.oper}${i.dl != null ? ' DL:' + i.dl : ''}${i.ul != null ? ' UL:' + i.ul : ''}`).join('\n') : 'LIVE: tidak ada (device belum dihubungkan)';
  const alarms = (c.alarms || []).map(a => `[${a.t}] ${a.sev} ${a.dev}: ${a.msg}`).join('\n');
  const down = (c.downtime || []).map(d => `${d.dev}: DOWN ${d.downStr} → ${d.upStr || 'masih DOWN'} (total ${d.totalMs ? Math.round(d.totalMs / 1000) + 's' : '?'})`).join('\n');
  const s = c.snapshot;
  let snapTxt = '(belum ada snapshot live)';
  if (s && s.error) snapTxt = 'Snapshot gagal: ' + s.error;
  else if (s) {
    snapTxt = `Router ${s.identity || '?'} (${s.ip}) ${s.board} RouterOS ${s.version} uptime ${s.uptime}` +
      `\nCPU ${s.cpuPct ?? '?'}% | RAM bebas ${s.memFreeMb ?? '?'}MB dari ${s.memTotalMb ?? '?'}MB` +
      `\nSemua interface (live, DL/UL Mbps):\n` +
      (s.interfaces || []).map(i => `- ${i.n} [${i.type}] admin:${i.admin} oper:${i.oper}${i.comment ? ' ("' + i.comment + '")' : ''} DL:${i.dlMbps} UL:${i.ulMbps}`).join('\n');
  }
  const dg = c.diag;
  let diagTxt = '';
  if (dg && !dg.error) {
    diagTxt = `\n\nDIAGNOSA DALAM (dieksekusi collector read-only):` +
      `\n- Interface detail:\n` + ((dg.ifaces || []).map(i => `  - ${i.n} [${i.type}] admin:${i.admin} oper:${i.oper} err:${i.err} drop:${i.drop}${i.comment ? ' ("' + i.comment + '")' : ''}`).join('\n') || '  (kosong)') +
      `\n- DHCP: ${dg.dhcp ? dg.dhcp.bound + '/' + dg.dhcp.total + ' bound (' + (dg.dhcp.sample || []).join(', ') + ')' : 'n/a ' + (dg.dhcpErr || '')}` +
      `\n- Route mati: ${(dg.routes && dg.routes.inactive && dg.routes.inactive.length) ? dg.routes.inactive.join('; ') : 'tidak ada (' + ((dg.routes || {}).total || 0) + ' route)'}` +
      `\n- Resource: ${dg.res ? (dg.res.board + ' ' + dg.res.version + ' up ' + dg.res.uptime + ' CPU ' + (dg.res.cpu ?? '?') + '%') : 'n/a'}`;
  } else if (dg && dg.error) diagTxt = '\n\nDiagnosa dalam gagal: ' + dg.error;
  const context = `DEVICE YANG LAGI DIBUKA: ${dev}\n\nDATA LIVE ROUTER (snapshot sekarang):\n${snapTxt}${diagTxt}\n\nStatus dari dashboard:\n${ifs || '(kosong)'}\n\n${lv}\n\nAlarm device ini:\n${alarms || '(tidak ada)'}\n\nRiwayat downtime device ini:\n${down || '(tidak ada)'}`;
  return [
    { role: 'system', content: AI_SYSTEM },
    { role: 'user', content: context + '\n\nPERTANYAAN USER:\n' + message },
  ];
}

module.exports = { aiAsk, buildMessages };

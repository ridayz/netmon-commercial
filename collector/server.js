// netmon-collector — jembatan dashboard <-> perangkat asli.
// Endpoints:
//   GET /health
//   GET /api/discover?ip=&user=&pass=&community=   -> identitas + interface (API, fallback SNMP)
//   GET /api/traffic?ip=&iface=&user=&pass=        -> rx/tx bps realtime (2x poll 1 dtk)
//   GET /api/dhcp?ip=&user=&pass=                  -> pool usage (RouterOS)
//   GET /api/conntrack?ip=&user=&pass=             -> conntrack count/max (RouterOS)
const http = require('http');
const { URL } = require('url');
const { RosApi, rosQuery } = require('./ros');
const snmpq = require('./snmpq');
const { aiAsk, buildMessages } = require('./ai');

function loadEnv() {
  try {
    require('fs').readFileSync(__dirname + '/.env', 'utf8').split('\n').forEach(l => {
      if (/^\s*#/.test(l)) return;
      const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    });
  } catch {}
}
loadEnv();
const PORT = Number(process.env.PORT || 8932);
const D = {
  user: process.env.ROS_USER || 'netmon', pass: process.env.ROS_PASS || '',
  port: Number(process.env.ROS_PORT || 8728), community: process.env.SNMP_COMMUNITY || 'public',
};
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', ...CORS }); res.end(JSON.stringify(obj)); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
// cache sample host-traffic antar request (top-level biar persist)

async function discover(q) {
  const ip = q.ip, user = q.user || D.user, pass = q.pass || D.pass, community = q.community || D.community;
  if (!ip) throw new Error('param ip wajib');
  // 1) coba RouterOS API
  try {
    const [ident, res, ifs] = await Promise.all([
      rosQuery(ip, user, pass, '/system/identity/print', {}, D.port),
      rosQuery(ip, user, pass, '/system/resource/print', {}, D.port),
      rosQuery(ip, user, pass, '/interface/print', {}, D.port),
    ]);
    return {
      ok: true, via: 'routeros-api', ip,
      identity: (ident[0] || {}).name || '', board: (res[0] || {})['board-name'] || '',
      version: (res[0] || {}).version || '', uptime: (res[0] || {})['uptime'] || '',
      cpu: (res[0] || {})['cpu-load'] || '',
      interfaces: ifs.map(i => ({ name: i.name, type: i.type, admin: i.disabled === 'true' ? 'down' : 'up', oper: i.running === 'true' ? 'up' : 'down', mac: i['mac-address'] || '' })),
    };
  } catch (eApi) {
    // 2) fallback SNMP (coba community yang dikasih + umum)
    const comms = [community, 'public', 'private'].filter((v, i, a) => v && a.indexOf(v) === i);
    let sys = null, ifs = null, usedCm = '';
    let lastErr = null;
    for (const cm of comms) {
      try {
        const [s, f] = await Promise.all([
          snmpq.get(ip, cm, [snmpq.OIDS.sysDescr, snmpq.OIDS.sysName, snmpq.OIDS.sysUpTime]),
          snmpq.ifaces(ip, cm),
        ]);
        sys = s; ifs = f; usedCm = cm; break;
      } catch (e) { lastErr = e; }
    }
    if (!sys) throw new Error('SNMP gagal semua community (' + comms.join('/') + '): ' + String((lastErr && lastErr.message) || eApi.message || eApi).slice(0, 80));
    const g = oid => (sys.find(v => v.oid === oid) || {}).value || '';
    return {
      ok: true, via: 'snmp', ip, apiError: String(eApi.message || eApi),
      sysDescr: g(snmpq.OIDS.sysDescr), sysName: g(snmpq.OIDS.sysName), uptime: g(snmpq.OIDS.sysUpTime), snmpCommunity: usedCm,
      interfaces: ifs.map(i => ({ name: i.descr || ('if' + i.idx), admin: i.admin, oper: i.oper })),
    };
  }
}

async function rosExport(host, user, pass, port) {
  const fs = require('fs');
  const api = new RosApi(host, port, 30000); // /export bisa lama, jangan pakai timeout default 5 dtk
  await api.connect();
  try {
    await api.talk(['/login', `=name=${user}`, `=password=${pass}`]);
    const sents = await api.rawSentences(['/export', '=compact']);
    await sleep(1500); // beri waktu reply export terakhir
    let s2 = await api.rawSentences([]);
    const lines = [];
    for (const s of [...sents, ...s2]) for (const w of s) {
      if (w === '!re' || w === '!done' || w === '!trap' || w === '!fatal' || w.startsWith('=ret=')) continue;
      lines.push(w.startsWith('=') ? w.slice(1) : w);
    }
    return lines.join('\n');
  } finally { api.close(); }
}

// denylist perintah tulis yang diusulkan AI: hanya user, reset, reboot
const ROS_DENY = /\/user|\/reset|\/reboot/i;
function vetRosCmd(path, args) {
  if (!path || typeof path !== 'string') return 'path kosong';
  if (ROS_DENY.test(path)) return 'path diblokir: ' + path;
  return null;
}
// ---- PLAN EXECUTOR (A: rencana AI / B: fix rule-based) ----
// op tulis yang diizinkan dalam rencana. Selain ini DITOLAK server.
const PLAN_OPS = ['iface-enable', 'iface-disable', 'iface-flap', 'queue-set', 'wifi-set', 'poe-cycle', 'conntrack-clear'];
function vetPlanStep(st) {
  if (!st || typeof st !== 'object') return 'langkah bukan objek';
  if (!PLAN_OPS.includes(st.op)) return 'op tidak diizinkan: ' + st.op;
  if (st.op === 'conntrack-clear') return null;
  const nm = st.iface || st.name;
  if (!nm || typeof nm !== 'string' || !nm.trim() || nm.length > 64) return 'target kosong/tidak valid untuk ' + st.op;
  if (/\/user|\/reset|\/reboot/i.test(nm)) return 'target diblokir';
  if (st.op === 'queue-set') {
    if (!/^(\d+[kKmM]?|0)\/(\d+[kKmM]?|0)$/.test(String(st.maxLimit || ''))) return 'maxLimit format salah (cth 0/10M)';
  }
  if (st.op === 'wifi-set') {
    if (!st.args || typeof st.args !== 'object' || !Object.keys(st.args).length) return 'wifi-set butuh args';
    const badK = Object.keys(st.args).find(k => !['frequency', 'tx-power', 'ssid', 'disabled'].includes(k));
    if (badK) return 'wifi arg tidak diizinkan: ' + badK;
  }
  return null;
}
async function rosIfacesFresh(ip, u, p) {
  const r = await rosQuery(ip, u, p, '/interface/print', { '.proplist': 'name,disabled,running' }, D.port);
  return r.map(i => ({ n: i.name, disabled: i.disabled === 'true', running: i.running === 'true' }));
}
async function planBackup(ip, u, p) {
  const text = await rosExport(ip, u, p, D.port);
  const fs2 = require('fs'); try { fs2.mkdirSync(__dirname + '/backups'); } catch {}
  const fn = 'pre-plan-' + ip.replace(/\./g, '-') + '-' + Date.now() + '.rsc';
  fs2.writeFileSync(__dirname + '/backups/' + fn, text);
  return fn;
}
// eksekusi 1 langkah + verifikasi baca-ulang. return {ok, detail, undo?}
async function planStepExec(ip, u, p, st, res_ver) {
  const nm = (st.iface || st.name || '').trim();
  const setIface = async dis => rosQuery(ip, u, p, '/interface/set', { numbers: nm, disabled: dis ? 'yes' : 'no' }, D.port);
  if (st.op === 'iface-enable') {
    const before = (await rosIfacesFresh(ip, u, p)).find(x => x.n === nm);
    if (!before) throw new Error('interface tidak ketemu: ' + nm);
    await setIface(false);
    const after = (await rosIfacesFresh(ip, u, p)).find(x => x.n === nm);
    if (after && after.disabled) throw new Error('verifikasi gagal: ' + nm + ' masih disabled');
    return { ok: true, detail: nm + ' admin UP', undo: async () => { await setIface(true); } };
  }
  if (st.op === 'iface-disable') {
    await setIface(true);
    const after = (await rosIfacesFresh(ip, u, p)).find(x => x.n === nm);
    if (after && !after.disabled) throw new Error('verifikasi gagal: ' + nm + ' masih enabled');
    return { ok: true, detail: nm + ' admin DOWN', undo: async () => { await setIface(false); } };
  }
  if (st.op === 'iface-flap') {
    await setIface(true); await sleep(3000); await setIface(false);
    const after = (await rosIfacesFresh(ip, u, p)).find(x => x.n === nm);
    if (after && after.disabled) throw new Error('verifikasi gagal: ' + nm + ' tidak nyala lagi');
    return { ok: true, detail: nm + ' flap ok (down 3 dtk → up)', undo: null };
  }
  if (st.op === 'queue-set') {
    const qs = await rosQuery(ip, u, p, '/queue/simple/print', { '.proplist': 'name,max-limit' }, D.port);
    const q = qs.find(x => x.name === nm);
    if (!q) throw new Error('queue tidak ketemu: ' + nm);
    const before = q['max-limit'] || '';
    await rosQuery(ip, u, p, '/queue/simple/set', { numbers: nm, 'max-limit': st.maxLimit }, D.port);
    const q2 = (await rosQuery(ip, u, p, '/queue/simple/print', { '.proplist': 'name,max-limit' }, D.port)).find(x => x.name === nm);
    if (!q2 || (q2['max-limit'] || '') !== st.maxLimit) throw new Error('verifikasi gagal: max-limit tidak berubah');
    return { ok: true, detail: nm + ' max-limit ' + before + ' → ' + st.maxLimit, undo: async () => { await rosQuery(ip, u, p, '/queue/simple/set', { numbers: nm, 'max-limit': before }, D.port); } };
  }
  if (st.op === 'wifi-set') {
    const ver = String((res_ver && res_ver.version) || '');
    const is7 = /^7\./.test(ver);
    const rows = is7
      ? await rosQuery(ip, u, p, '/interface/wifi/print', {}, D.port).catch(() => null)
      : await rosQuery(ip, u, p, '/interface/wireless/print', {}, D.port).catch(() => null);
    const useWifi = Array.isArray(rows) ? (is7 ? 'wifi' : 'wireless') : (is7 ? 'wireless' : 'wifi');
    const path = '/interface/' + useWifi + '/print';
    const before = (await rosQuery(ip, u, p, path, {}, D.port)).find(x => x.name === nm);
    if (!before) throw new Error('radio tidak ketemu: ' + nm);
    const setPath = '/interface/' + useWifi + '/set';
    const args = { numbers: nm }; Object.assign(args, st.args || {});
    await rosQuery(ip, u, p, setPath, args, D.port);
    const after = (await rosQuery(ip, u, p, path, {}, D.port)).find(x => x.name === nm);
    const key = Object.keys(st.args || {})[0];
    const okV = after && key && String(after[key] ?? after[key.replace('-', '')] ?? '') !== '';
    if (!okV) throw new Error('verifikasi gagal: ' + nm);
    const undoArgs = {}; Object.keys(st.args || {}).forEach(k => { if (before[k] !== undefined) undoArgs[k] = before[k]; });
    return { ok: true, detail: nm + ' ' + JSON.stringify(st.args), undo: Object.keys(undoArgs).length ? (async () => { await rosQuery(ip, u, p, setPath, { numbers: nm, ...undoArgs }, D.port); }) : null };
  }
  if (st.op === 'poe-cycle') {
    let before = 'auto-on';
    try {
      const pr = await rosQuery(ip, u, p, '/interface/ethernet/poe/print', { '.proplist': 'name,poe-out' }, D.port);
      const row = pr.find(x => x.name === nm); if (row && row['poe-out']) before = row['poe-out'];
    } catch {}
    await rosQuery(ip, u, p, '/interface/ethernet/poe/set', { numbers: nm, 'poe-out': 'off' }, D.port);
    await sleep(5000);
    await rosQuery(ip, u, p, '/interface/ethernet/poe/set', { numbers: nm, 'poe-out': before }, D.port);
    return { ok: true, detail: nm + ' PoE off 5 dtk → ' + before, undo: null };
  }
  if (st.op === 'conntrack-clear') {
    const c0 = (await rosQuery(ip, u, p, '/ip/firewall/connection/print', { '.proplist': 'src-address' }, D.port)).length;
    if (!c0) return { ok: true, detail: 'conntrack sudah kosong', undo: null };
    const all = await rosQuery(ip, u, p, '/ip/firewall/connection/print', { '.proplist': 'src-address' }, D.port);
    const ids = all.map(x => x._id).filter(Boolean);
    for (let i = 0; i < ids.length; i += 100) {
      await rosQuery(ip, u, p, '/ip/firewall/connection/remove', { numbers: ids.slice(i, i + 100).join(',') }, D.port).catch(() => {});
    }
    await sleep(1500);
    const c1 = (await rosQuery(ip, u, p, '/ip/firewall/connection/print', { '.proplist': 'src-address' }, D.port)).length;
    if (c1 > c0 * 0.5) throw new Error('verifikasi gagal: conntrack masih ' + c1);
    return { ok: true, detail: 'conntrack ' + c0 + ' → ' + c1 + ' (tanpa rollback: koneksi reconnect sendiri)', undo: null };
  }
  throw new Error('op tidak dikenal: ' + st.op);
}
// runner rencana: backup → langkah berurutan + verifikasi → rollback bila gagal
async function runPlan(ip, user, pass, steps, title) {
  const results = [];
  let backupFile = null;
  try { backupFile = await planBackup(ip, user, pass); }
  catch (e) { return { ok: false, steps: results, rolledBack: false, backupFile: null, error: 'backup config gagal — rencana DIBATALKAN demi keamanan: ' + String(e.message || e).slice(0, 100) }; }
  let res_ver = null;
  try { const rv = await rosQuery(ip, user, pass, '/system/resource/print', {}, D.port); res_ver = { version: (rv[0] || {}).version || '' }; } catch {}
  const undos = [];
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i];
    try {
      const r = await planStepExec(ip, user, pass, st, res_ver);
      results.push({ label: st.label || (st.op + ' ' + (st.iface || st.name || '')), ok: true, detail: r.detail });
      if (r.undo) undos.push(r.undo);
    } catch (e) {
      results.push({ label: st.label || (st.op + ' ' + (st.iface || st.name || '')), ok: false, detail: String(e.message || e).slice(0, 140) });
      let rolledBack = true;
      for (let k = undos.length - 1; k >= 0; k--) { try { await undos[k](); } catch { rolledBack = false; } }
      return { ok: false, steps: results, rolledBack, backupFile, error: 'langkah ' + (i + 1) + '/' + steps.length + ' gagal: ' + String(e.message || e).slice(0, 120) };
    }
  }
  return { ok: true, steps: results, rolledBack: false, backupFile };
}
// tiket approve untuk aksi tulis (dongkrak 5 menit)
const PENDING = new Map();
function mkTicket(op) {
  const t = 'AP-' + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 99);
  PENDING.set(t, { ...op, at: Date.now() });
  setTimeout(() => PENDING.delete(t), 5 * 60 * 1000).unref?.();
  return t;
}
// cari IP target dari pesan / konteks (IP literal > selected > 1 live device)
function resolveTarget(message, ctx) {
  const m = String(message || '').match(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
  if (m) return { ip: m[0], how: 'ip-dari-pesan' };
  const sel = String((ctx || {}).selected || '');
  const ms = sel.match(/IP (\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
  if (ms) return { ip: ms[1], how: 'device-dipantau' };
  const live = Object.keys((ctx || {}).liveMap || {});
  if (live.length === 1) { const L = (ctx.liveMap || {})[live[0]]; if (L && L.ip) return { ip: L.ip, how: 'satu-satunya-live' }; }
  for (const k of live) {
    const L = (ctx.liveMap || {})[k];
    if (L && L.identity && message.toLowerCase().includes(String(L.identity).toLowerCase())) return { ip: L.ip, how: 'nama-device' };
  }
  const lv = (ctx || {}).live || null;
  if (lv && lv.ip) {
    const idn = String(lv.identity || '').toLowerCase();
    const low = message.toLowerCase();
    const devName = String(sel || '').split('/')[0].toLowerCase();
    // device yang lagi dibuka = default target kalau user tidak sebut IP/device lain
    const otherIp = (ctx || {}).liveMap && Object.values(ctx.liveMap).some(L => L && L.identity && low.includes(String(L.identity).toLowerCase()) && L.ip !== lv.ip);
    if (!otherIp) return { ip: lv.ip, how: 'device-terbuka' };
  }
  return null;
}
async function traffic(q) {
  const ip = q.ip, user = q.user || D.user, pass = q.pass || D.pass, iface = q.iface, community = q.community || D.community;
  if (!ip || !iface) throw new Error('param ip & iface wajib');
  const snmpTraffic = async () => {
    const once = async () => {
      const all = await snmpq.ifaces(ip, community);
      const f = all.find(i => i.descr === iface) || all.find(i => ('if' + i.idx) === iface);
      if (!f) throw new Error('interface tidak ketemu (snmp): ' + iface);
      return f;
    };
    const t0 = Date.now();
    const a = await once();
    await sleep(1200);
    const b = await once();
    const dt = Math.max(0.5, (Date.now() - t0) / 1000);
    const diff = (x, y) => { let d = y - x; if (d < 0) d += 4294967296; return d; };
    const rx = diff(a.inOct, b.inOct) * 8 / dt, tx = diff(a.outOct, b.outOct) * 8 / dt;
    return { ok: true, ip, iface, src: 'snmp', rxBps: Math.round(rx), txBps: Math.round(tx), rxMbps: +(rx / 1e6).toFixed(2), txMbps: +(tx / 1e6).toFixed(2) };
  };
  if (q.via === 'snmp') return snmpTraffic();
  try {
    const r = await rosQuery(ip, user, pass, '/interface/monitor-traffic', { interface: iface, once: '' }, D.port);
    const a = r[0] || {};
    const rx = Number(a['rx-bits-per-second'] || 0), tx = Number(a['tx-bits-per-second'] || 0);
    return { ok: true, ip, iface, src: 'monitor', rxBps: rx, txBps: tx, rxMbps: +(rx / 1e6).toFixed(2), txMbps: +(tx / 1e6).toFixed(2) };
  } catch (eMon) {
    try {
    const once = async () => {
      const all = await rosQuery(ip, user, pass, '/interface/print', { '.proplist': 'name,rx-byte,tx-byte' }, D.port);
      const f = all.find(i => i.name === iface);
      if (!f) throw new Error('interface tidak ketemu: ' + iface);
      return f;
    };
    const a = await once();
    await sleep(1000);
    const b = await once();
    const rx = (Number(b['rx-byte'] || 0) - Number(a['rx-byte'] || 0)) * 8;
    const tx = (Number(b['tx-byte'] || 0) - Number(a['tx-byte'] || 0)) * 8;
    if (rx < 0 || tx < 0) throw new Error('counter aneh');
    return { ok: true, ip, iface, src: 'counter', rxBps: rx, txBps: tx, rxMbps: +(rx / 1e6).toFixed(2), txMbps: +(tx / 1e6).toFixed(2) };
    } catch (e2) {
      if (community) return snmpTraffic();
      throw e2;
    }
  }
}

// ---- HOST (server lokal(netmon) sendiri): daftar NIC + traffic realtime ----
// Windows: Get-NetAdapterStatistics (bytes per NIC). Linux: /proc/net/dev.
function hostCounters() {
  const { execFileSync } = require('child_process');
  const out = [];
  if (process.platform === 'win32') {
    const ps = 'Get-NetAdapterStatistics | Select-Object Name,ReceivedBytes,SentBytes | ConvertTo-Json -Compress';
    const raw = execFileSync('powershell', ['-NoProfile', '-Command', ps], { timeout: 10000, encoding: 'utf8', windowsHide: true });
    let arr;
    try { arr = JSON.parse(raw); } catch { throw new Error('parse Get-NetAdapterStatistics gagal'); }
    if (!Array.isArray(arr)) arr = arr ? [arr] : [];
    for (const r of arr) {
      if (!r || !r.Name) continue;
      out.push({ name: String(r.Name), inOct: Number(r.ReceivedBytes) || 0, outOct: Number(r.SentBytes) || 0 });
    }
  } else {
    const fs = require('fs');
    const txt = fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2);
    for (const ln of txt) {
      const m = ln.trim().match(/^([^:]+):\s*(.+)$/);
      if (!m) continue;
      const f = m[2].trim().split(/\s+/).map(Number);
      if (f.length < 9 || isNaN(f[0])) continue;
      out.push({ name: m[1].trim(), inOct: f[0] || 0, outOct: f[8] || 0 });
    }
  }
  return out.filter(r => r.name && r.name.toLowerCase() !== 'loopback pseudo-interface 1' && r.name !== 'lo');
}
async function hostInfo() {
  const os = require('os');
  const all = hostCounters();
  return {
    ok: true, via: 'host', ip: '127.0.0.1',
    identity: os.hostname() || 'server-lokal',
    interfaces: all.map(i => ({ name: i.name, admin: 'up', oper: 'up' })),
  };
}
// sampler latar: 1x baca counter per ~3 dtk untuk SEMUA nic; request serve cache instan (tanpa powershell di request path)
const _hostCache={t:0,by:{}};
async function hostSampleLoop(){
  for(;;){
    try{
      const all=hostCounters();
      const now=Date.now(),by={};
      for(const f of all){
        const prev=_hostCache.by[f.name];
        let rx=0,tx=0;
        if(prev&&now-prev.t>=500){const dt=Math.max(0.5,(now-prev.t)/1000);rx=Math.max(0,f.inOct-prev.inOct)*8/dt;tx=Math.max(0,f.outOct-prev.outOct)*8/dt;}
        by[f.name]={t:now,inOct:f.inOct,outOct:f.outOct,rxBps:Math.round(rx),txBps:Math.round(tx),rxMbps:+(rx/1e6).toFixed(2),txMbps:+(tx/1e6).toFixed(2)};
      }
      _hostCache.t=now;_hostCache.by=by;
    }catch(e){/* coba lagi ronde berikut */}
    await sleep(3000);
  }
}
hostSampleLoop();
async function hostTraffic(iface) {
  if (!iface) throw new Error('param iface wajib');
  const s=_hostCache.by[iface];
  if (!s) {
    const names=Object.keys(_hostCache.by);
    throw new Error(names.length?('NIC tidak ketemu: '+iface+' (ada: '+names.slice(0,6).join(', ')+')'):'sampler host belum siap, coba lagi 5 dtk');
  }
  const stale=Date.now()-_hostCache.t>12000;
  return { ok:true, ip:'127.0.0.1', iface, src:'host', stale:stale||undefined, rxBps:s.rxBps, txBps:s.txBps, rxMbps:s.rxMbps, txMbps:s.txMbps };
}
// diagnosa dalam (read-only): error counter + dhcp + route + resource, paralel, partial-OK
async function diagDeep(ip, user, pass) {
  const u = user || D.user, p = pass || D.pass;
  const out = { ip };
  const jobs = [
    rosQuery(ip, u, p, '/interface/print', { '.proplist': 'name,type,disabled,running,rx-byte,tx-byte,rx-drop,tx-drop,rx-error,tx-error,comment' }, D.port).then(r => {
      out.ifaces = r.map(i => ({ n: i.name, type: i.type, admin: i.disabled === 'true' ? 'down' : 'up', oper: i.running === 'true' ? 'up' : 'down', rxB: Number(i['rx-byte'] || 0), txB: Number(i['tx-byte'] || 0), drop: Number(i['rx-drop'] || 0) + Number(i['tx-drop'] || 0), err: Number(i['rx-error'] || 0) + Number(i['tx-error'] || 0), comment: i.comment || '' }));
    }).catch(e => { out.ifaceErr = String(e.message || e).slice(0, 80); }),
    rosQuery(ip, u, p, '/ip/dhcp-server/lease/print', { '.proplist': 'address,mac-address,status,host-name' }, D.port).then(r => {
      const act = r.filter(l => (l.status || '').startsWith('bound'));
      out.dhcp = { total: r.length, bound: act.length, sample: act.slice(0, 5).map(l => l.address + (l['host-name'] ? ' (' + l['host-name'] + ')' : '')) };
    }).catch(e => { out.dhcpErr = String(e.message || e).slice(0, 80); }),
    rosQuery(ip, u, p, '/ip/route/print', { '.proplist': 'dst-address,gateway,active' }, D.port).then(r => {
      const dead = r.filter(x => x.active !== 'true');
      out.routes = { total: r.length, inactive: dead.slice(0, 5).map(x => (x['dst-address'] || '?') + ' via ' + (x.gateway || '?')) };
    }).catch(e => { out.routeErr = String(e.message || e).slice(0, 80); }),
    rosQuery(ip, u, p, '/system/resource/print', {}, D.port).then(r => {
      const a = r[0] || {};
      out.res = { board: a['board-name'] || '', version: a.version || '', uptime: a.uptime || '', cpu: a['cpu-load'] != null ? Number(a['cpu-load']) : null };
    }).catch(e => { out.resErr = String(e.message || e).slice(0, 80); }),
    rosQuery(ip, u, p, '/queue/simple/print', { '.proplist': 'name,target,max-limit' }, D.port).then(r => {
      out.queue = r.map(q => ({ name: q.name, target: q.target || '', maxLimit: q['max-limit'] || '' }));
    }).catch(e => { out.queueErr = String(e.message || e).slice(0, 80); }),
    rosQuery(ip, u, p, '/interface/wifi/print', { '.proplist': 'name,disabled,running' }, D.port).then(r => {
      out.wifi = r.map(w => ({ name: w.name, radio: 'wifi', admin: w.disabled === 'true' ? 'down' : 'up', oper: w.running === 'true' ? 'up' : 'down' }));
    }).catch(() => { out.wifi = null; }),
    rosQuery(ip, u, p, '/interface/wireless/print', { '.proplist': 'name,disabled,running,frequency,ssid' }, D.port).then(r => {
      if (!out.wifi) out.wifi = r.map(w => ({ name: w.name, radio: 'wireless', admin: w.disabled === 'true' ? 'down' : 'up', oper: w.running === 'true' ? 'up' : 'down', frequency: w.frequency || '', ssid: w.ssid || '' }));
    }).catch(() => {}),
    rosQuery(ip, u, p, '/ip/firewall/connection/print', { '.proplist': 'src-address' }, D.port).then(r => {
      out.conntrack = { count: r.length };
    }).catch(e => { out.conntrackErr = String(e.message || e).slice(0, 80); }),
  ];
  await Promise.all(jobs);
  return out;
}

// snapshot live router buat konteks AI: semua interface (status + rate), resource, dan identitas
async function snapshot(ip, user, pass) {
  const u = user || D.user, p = pass || D.pass;
  const [ifs1, res1, id] = await Promise.all([
    rosQuery(ip, u, p, '/interface/print', { '.proplist': 'name,type,disabled,running,rx-byte,tx-byte,comment' }, D.port),
    rosQuery(ip, u, p, '/system/resource/print', {}, D.port).catch(() => []),
    rosQuery(ip, u, p, '/system/identity/print', {}, D.port).catch(() => []),
  ]);
  await sleep(1000);
  const ifs2 = await rosQuery(ip, u, p, '/interface/print', { '.proplist': 'name,rx-byte,tx-byte' }, D.port);
  const b = Object.fromEntries(ifs2.map(i => [i.name, i]));
  const interfaces = ifs1.map(i => {
    const n = b[i.name] || {};
    const rx = (Number(n['rx-byte'] || 0) - Number(i['rx-byte'] || 0)) * 8;
    const tx = (Number(n['tx-byte'] || 0) - Number(i['tx-byte'] || 0)) * 8;
    return { n: i.name, type: i.type, admin: i.disabled === 'true' ? 'down' : 'up', oper: i.running === 'true' ? 'up' : 'down', comment: i.comment || '', dlMbps: +(rx / 1e6).toFixed(2), ulMbps: +(tx / 1e6).toFixed(2) };
  });
  const r = res1[0] || {};
  return {
    ip, identity: (id[0] || {}).name || '',
    board: r['board-name'] || '', version: r.version || '', uptime: r.uptime || '',
    cpuPct: r['cpu-load'] != null ? Number(r['cpu-load']) : null,
    memFreeMb: r['free-memory'] ? +(Number(r['free-memory']) / 1048576).toFixed(1) : null,
    memTotalMb: r['total-memory'] ? +(Number(r['total-memory']) / 1048576).toFixed(1) : null,
    interfaces,
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  try {
    const u = new URL(req.url, 'http://x');
    const q = Object.fromEntries(u.searchParams);
    if (u.pathname === '/health') return send(res, 200, { ok: true, service: 'netmon-collector' });
// progres AI per request (dipoll dashboard biar kelihatan hidup)
const AIPROG = new Map();
function aiProg(id, stage) {
  if (!id) return;
  let e = AIPROG.get(id);
  if (!e) { e = { t: Date.now(), log: [], done: false }; AIPROG.set(id, e); setTimeout(() => AIPROG.delete(id), 120000).unref?.(); }
  e.log.push({ at: Date.now(), stage });
  if (stage === 'selesai' || stage.startsWith('gagal')) e.done = true;
}
    if (u.pathname === '/api/ai-progress') {
      const e = AIPROG.get(q.id);
      if (!e) return send(res, 200, { ok: true, done: false, stages: [] });
      return send(res, 200, { ok: true, done: !!e.done, stages: e.log });
    }
    if (u.pathname === '/api/diag') {
      // analyzer lokal TANPA AI key: vonis deterministik dari data read-only
      const ip = q.ip;
      if (!ip) throw new Error('param ip wajib');
      const diag = await diagDeep(ip, q.user, q.pass);
      const masalah = [], saran = [];
      (diag.ifaces || []).forEach(i => {
        if (i.admin === 'down') { masalah.push(`${i.n}: admin DOWN (disable manual/sengaja)`); saran.push(`Enable ${i.n} kalau memang harus nyala`); }
        else if (i.oper === 'down') {
          if (i.err > 0 || i.drop > 0) { masalah.push(`${i.n}: DOWN + err ${i.err}/drop ${i.drop} — kabel jelek/konektor`); saran.push(`Cek crimping + ganti kabel ${i.n}`); }
          else { masalah.push(`${i.n}: DOWN (kabel dicabut / perangkat ujung mati)`); saran.push(`Colok kabel ${i.n} / nyalakan perangkat ujungnya`); }
        }
        else if (i.err > 100 || i.drop > 100) { masalah.push(`${i.n}: UP tapi err ${i.err}/drop ${i.drop} tinggi`); saran.push(`Jadwalkan ganti kabel ${i.n}, cek interferensi/negosiasi speed`); }
      });
      if (diag.dhcp && diag.dhcp.total > 0) {
        const pct = Math.round(100 * diag.dhcp.bound / diag.dhcp.total);
        if (pct >= 90) { masalah.push(`DHCP pool ${pct}% penuh (${diag.dhcp.bound}/${diag.dhcp.total})`); saran.push('Perluas pool / pendekkan lease-time'); }
      }
      if (diag.routes && diag.routes.inactive && diag.routes.inactive.length) { masalah.push(`Route mati: ${diag.routes.inactive.join('; ')}`); saran.push('Cek gateway/link route yang mati'); }
      if (diag.res && diag.res.cpu != null && diag.res.cpu >= 80) { masalah.push(`CPU ${diag.res.cpu}% — overload`); saran.push('Cek firewall rules/conn-track, matikan service nganggur'); }
      const fixes = [];
      const seenFix = new Set();
      const addFix = f => { const k = f.kind + ':' + (f.iface || f.name || ''); if (!seenFix.has(k)) { seenFix.add(k); fixes.push(f); } };
      (diag.ifaces || []).forEach(i => {
        if (i.admin === 'down') addFix({ kind: 'iface-enable', iface: i.n, label: `Enable ${i.n} (admin DOWN)`, evidence: `${i.n}: admin DOWN di device`, risk: 'medium — pastikan port memang harus nyala' });
        else if (i.oper === 'up' && (i.err > 100 || i.drop > 100)) addFix({ kind: 'iface-flap', iface: i.n, label: `Flap ${i.n} (err ${i.err}/drop ${i.drop})`, evidence: `${i.n}: UP tapi err ${i.err}/drop ${i.drop}`, risk: 'low — putus sesaat ±3 detik' });
      });
      const parseRate = v => { const m = String(v || '').match(/^(\d+)([kKmM]?)$/); if (!m) return null; return Number(m[1]) * (m[2].toLowerCase() === 'm' ? 1e6 : m[2].toLowerCase() === 'k' ? 1e3 : 1); };
      (diag.queue || []).forEach(qd => {
        const parts = String(qd.maxLimit || '').split('/');
        const ul = parseRate(parts[0]);
        if (ul != null && ul > 0 && ul < 2e6) {
          const fmt = v => v >= 1e6 ? (v / 1e6) + 'M' : Math.round(v / 1e3) + 'k';
          const newUl = Math.max(ul * 2, 5e6);
          addFix({ kind: 'queue-set', name: qd.name, maxLimit: '0/' + fmt(newUl), label: `Naikkan limit upload ${qd.name} (${qd.maxLimit} → 0/${fmt(newUl)})`, evidence: `queue ${qd.name}: max-limit ${qd.maxLimit} (upload kekecilan)`, risk: 'low — bisa dikembalikan' });
        }
      });
      (diag.wifi || []).forEach(w => {
        if (w.admin === 'down') addFix({ kind: 'iface-enable', iface: w.name, label: `Enable radio ${w.name} (admin DOWN)`, evidence: `radio ${w.name}: admin DOWN`, risk: 'low' });
      });
      if (diag.conntrack && diag.conntrack.count > 10000) addFix({ kind: 'conntrack-clear', label: `Bersihkan conntrack (${diag.conntrack.count} koneksi)`, evidence: `conntrack ${diag.conntrack.count} koneksi (ambang 10000)`, risk: 'low — koneksi aktif reconnect sendiri' });
      const vonis = !masalah.length ? `SEHAT — ${(diag.ifaces || []).length} interface UP semua, no error` : `ADA ${masalah.length} TEMUAN`;
      return send(res, 200, { ok: true, ip, vonis, masalah, saran, fixes, diag });
    }
    if (u.pathname === '/api/ai-test' && req.method === 'POST') {      const body = await new Promise((resolve, reject) => {
        let b = ''; req.on('data', c => { b += c; });
        req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { reject(new Error('body bukan JSON')); } });
        req.on('error', reject);
      });
      const key = (body.aiKey && String(body.aiKey).trim()) || process.env.AI_KEY || '';
      const baseURL = (body.aiBase && String(body.aiBase).trim()) || process.env.AI_BASE_URL || 'http://localhost:20128/v1';
      const model = (body.aiModel && String(body.aiModel).trim()) || process.env.AI_MODEL || 'nine-router/auto-failover';
      try {
        const reply = await aiAsk({ baseURL, key, model, messages: [{ role: 'user', content: 'balas: ok' }], timeoutMs: 30000 });
        return send(res, 200, { ok: true, model, reply: String(reply).slice(0, 80) });
      } catch (e) { return send(res, 200, { ok: false, error: String(e.message || e).slice(0, 120) }); }
    }
    if (u.pathname === '/api/ai-ask' && req.method === 'POST') {
      const body = await new Promise((resolve, reject) => {
        let b = ''; req.on('data', c => { b += c; if (b.length > 200000) req.destroy(); });
        req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { reject(new Error('body bukan JSON')); } });
        req.on('error', reject);
      });
      if (!body.message) throw new Error('param message wajib');
      const msg = String(body.message), ctx = body.ctx || {};
      const WU = process.env.W_USER || '', WP = process.env.W_PASS || '';
      const low = msg.toLowerCase();
      // --- INTENT: backup config ---
      if (/backup/.test(low)) {
        const t = resolveTarget(msg, ctx);
        if (!t) return send(res, 200, { ok: true, mode: 'intent', reply: 'Mau backup yang mana men? Sebutin IP-nya, atau buka dulu device-nya di dashboard. Cth: "backup 192.168.18.6".' });
        const text = await rosExport(t.ip, q.user || D.user, q.pass || D.pass, D.port);
        const fs = require('fs');
        try { fs.mkdirSync(__dirname + '/backups'); } catch {}
        const safe = t.ip.replace(/\./g, '-') + '-' + new Date().toISOString().slice(0, 10);
        fs.writeFileSync(__dirname + '/backups/' + safe + '.rsc', text);
        const lines = text.split('\n').length;
        return send(res, 200, { ok: true, mode: 'intent', reply: `Backup ${t.ip} beres men (${lines} baris, ${(text.length / 1024).toFixed(1)} KB). File tersimpan di collector/backups/.`, files: [{ name: safe + '.rsc', url: '/api/backup-file?name=' + safe + '.rsc' }] });
      }
      // --- INTENT: enable/disable interface ---
      const mED = low.match(/(enable|disable|nyalakan|matikan|hidupkan|matiin)\s+([a-z0-9\-_]+)/);
      if (mED) {
        const t = resolveTarget(msg, ctx);
        if (!t) return send(res, 200, { ok: true, mode: 'intent', reply: 'Interface-nya di device mana men? Sebutin IP-nya. Cth: "disable ether3 192.168.18.6".' });
        if (!WU || !WP) return send(res, 200, { ok: true, mode: 'intent', reply: 'Aksi tulis belum dikonfigurasi men. Bikin user tulis dulu di device:\n/user group add name=mon-write policy=api,read,write\n/user add name=netmon-write group=mon-write password=XXXX\nTerus isi W_USER + W_PASS di .env collector + restart.' });
        const dis = /disable|matikan|matiin/.test(mED[1]);
        const op = { kind: dis ? 'iface-disable' : 'iface-enable', ip: t.ip, iface: mED[2] };
        const ticket = mkTicket(op);
        return send(res, 200, { ok: true, mode: 'intent', reply: dis ? `Mau DISABLE ${op.iface} di ${t.ip} — ini mutus koneksi loh. Klik Setujui + isi login tulis.` : `Mau ENABLE ${op.iface} di ${t.ip}. Klik Setujui + isi login tulis.`, actions: [{ ticket, label: `✅ Setujui: ${dis ? 'disable' : 'enable'} ${op.iface}` }] });
      }
      const baseURL = (body.aiBase && String(body.aiBase).trim()) || process.env.AI_BASE_URL || 'http://localhost:20128/v1';
      const key = (body.aiKey && String(body.aiKey).trim()) || process.env.AI_KEY || '';
      const model = (body.aiModel && String(body.aiModel).trim()) || process.env.AI_MODEL || 'nine-router/auto-failover';
      // snapshot live device terbuka (kalau ada) → AI dapat data nyata, bukan cuma tampilan
      let snap = null, diag = null, accessed = null;
      const lv = (body.ctx || {}).live;
      const reqId = body.reqId || '';
      aiProg(reqId, 'mulai — target ' + ((lv && lv.ip) || 'belum ada device live'));
      if (lv && lv.ip) {
        aiProg(reqId, '📡 baca snapshot ' + lv.ip + ' ...');
        try { snap = await snapshot(lv.ip, q.user, q.pass); aiProg(reqId, '✔ snapshot ok (' + (((snap || {}).interfaces || []).length) + ' interface)'); } catch (e) { snap = { error: String(e.message || e).slice(0, 120) }; aiProg(reqId, 'gagal snapshot: ' + snap.error); }
        if (/troubleshoot|verifikasi|diagnosa|diagnosis|cek |cek$|error|kenapa|masalah|periksa|analisa|down|lemot|lambat/i.test(msg)) {
          aiProg(reqId, '🔍 diagnosa dalam (error/DHCP/route/resource) ...');
          try { diag = await diagDeep(lv.ip, q.user, q.pass); accessed = `${diag.ip} (${(lv.identity || '')}) — ${((diag.ifaces || []).length)} interface dibaca`; aiProg(reqId, '✔ diagnosa ok'); } catch (e) { diag = { error: String(e.message || e).slice(0, 120) }; aiProg(reqId, 'gagal diagnosa: ' + diag.error); }
        } else accessed = `${lv.ip} (${lv.identity || ''})`;
      }
      const ctxAll = { ...(body.ctx || {}), snapshot: snap, diag, wantPlan: !!body.wantPlan };
      aiProg(reqId, '🤖 kirim ke AI (' + model + ') ...');
      const reply = await aiAsk({ baseURL, key, model, messages: buildMessages(body.message, ctxAll) });
      aiProg(reqId, '✔ AI jawab, proses tiket ...');
      // AI boleh mengusulkan perubahan lewat blok ```ros-cmd {json}```. Itu hanya jadi tiket, TIDAK dieksekusi.
      const proposals = [];
      const reCmd = /```ros-cmd\s*([\s\S]*?)```/g; let mm;
      while ((mm = reCmd.exec(reply)) !== null) {
        try {
          const p = JSON.parse(mm[1].trim());
          const bad = vetRosCmd(p.path, p.args);
          if (bad) { proposals.push({ rejected: bad }); continue; }
          if (!snap || !snap.ip) { proposals.push({ rejected: 'tidak ada device terbuka sebagai target' }); continue; }
          const label = p.label || (p.path + ' ' + JSON.stringify(p.args || {}));
          const ticket = mkTicket({ kind: 'ros-cmd', ip: snap.ip, path: p.path, args: p.args || {}, label });
          proposals.push({ ticket, label: '✅ Setujui: ' + label });
        } catch (e) { proposals.push({ rejected: 'format usulan salah' }); }
      }
      let plan = null;
      const rejectedPlan = [];
      try {
        const rePlan = /```ai-plan\s*([\s\S]*?)```/g; let mp;
        while ((mp = rePlan.exec(reply)) !== null) {
          if (plan) { rejectedPlan.push('ditolak: hanya 1 rencana per jawaban'); continue; }
          try {
            const p = JSON.parse(mp[1].trim());
            if (!p || !Array.isArray(p.steps) || !p.steps.length || p.steps.length > 5) throw new Error('rencana harus 1-5 langkah');
            const targetIp = (snap && snap.ip) || null;
            if (!targetIp) throw new Error('tidak ada device target');
            for (const st of p.steps) {
              const bad = vetPlanStep(st);
              if (bad) throw new Error(bad);
              st.ip = targetIp;
              if (!st.label) st.label = st.op + ' ' + (st.iface || st.name || '');
            }
            const ticket = mkTicket({ kind: 'ai-plan', ip: targetIp, title: String(p.title || 'rencana fix').slice(0, 120), steps: p.steps });
            plan = { title: String(p.title || 'rencana fix').slice(0, 120), evidence: Array.isArray(p.evidence) ? p.evidence.slice(0, 8) : [], steps: p.steps.map(x => ({ label: x.label, op: x.op })), ticket };
          } catch (e) { rejectedPlan.push('ditolak: rencana tidak valid (' + String(e.message || e).slice(0, 80) + ')'); }
        }
      } catch (e) { rejectedPlan.push('ditolak: parse rencana gagal'); }
      const cleanReply = reply.replace(/```ros-cmd[\s\S]*?```/g, '').replace(/```ai-plan[\s\S]*?```/g, '').trim();
      const rejected = rejectedPlan.concat(proposals.filter(p => p.rejected).map(p => 'ditolak: ' + p.rejected));
      const actions = proposals.filter(p => p.ticket).map(p => ({ ticket: p.ticket, label: p.label }));
      aiProg(reqId, 'selesai');
      return send(res, 200, { ok: true, model, accessed, reply: cleanReply + (rejected.length ? '\n\n' + rejected.join('\n') : ''), actions: actions.length ? actions : undefined, plan: plan || undefined });
    }
    if (u.pathname === '/api/iface-enable') {
      const ip = q.ip, iface = q.iface, user = q.user || process.env.W_USER || '', pass = q.pass || process.env.W_PASS || '';
      if (!ip || !iface) throw new Error('param ip & iface wajib');
      if (!user || !pass) throw new Error('W_USER/W_PASS belum diisi di .env');
      await rosQuery(ip, user, pass, '/interface/set', { numbers: iface, disabled: 'no' }, D.port);
      return send(res, 200, { ok: true, ip, iface, action: 'enable' });
    }
    if (u.pathname === '/api/diag-fix-ticket' && req.method === 'POST') {
      const body = await new Promise((resolve, reject) => {
        let b = ''; req.on('data', c => { b += c; });
        req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { reject(new Error('body bukan JSON')); } });
        req.on('error', reject);
      });
      const ip = body.ip, kind = body.kind;
      if (!ip || !kind) throw new Error('param ip & kind wajib');
      if (!PLAN_OPS.includes(kind)) throw new Error('kind tidak diizinkan: ' + kind);
      const fresh = await diagDeep(ip, body.user, body.pass);
      let step = null, label = '';
      if (kind === 'iface-enable') {
        const t = (fresh.ifaces || []).find(x => x.n === body.iface);
        if (!t) throw new Error('interface tidak ketemu: ' + body.iface);
        if (t.admin !== 'down') throw new Error('kondisi sudah berubah: ' + body.iface + ' tidak lagi admin DOWN');
        step = { label: 'Enable ' + t.n + ' (admin DOWN)', op: 'iface-enable', iface: t.n }; label = step.label;
      } else if (kind === 'iface-flap') {
        const t = (fresh.ifaces || []).find(x => x.n === body.iface);
        if (!t) throw new Error('interface tidak ketemu: ' + body.iface);
        if (!(t.oper === 'up' && (t.err > 100 || t.drop > 100))) throw new Error('kondisi sudah berubah: ' + body.iface + ' tidak lagi err/drop tinggi');
        step = { label: 'Flap ' + t.n + ' (err ' + t.err + '/drop ' + t.drop + ')', op: 'iface-flap', iface: t.n }; label = step.label;
      } else if (kind === 'queue-set') {
        const qd = (fresh.queue || []).find(x => x.name === body.name);
        if (!qd) throw new Error('queue tidak ketemu: ' + body.name);
        if (!/^(\d+[kKmM]?|0)\/(\d+[kKmM]?|0)$/.test(String(body.maxLimit || ''))) throw new Error('maxLimit format salah');
        step = { label: 'Set ' + qd.name + ' max-limit ' + qd.maxLimit + ' ke ' + body.maxLimit, op: 'queue-set', name: qd.name, maxLimit: body.maxLimit }; label = step.label;
      } else if (kind === 'conntrack-clear') {
        const c = (fresh.conntrack && fresh.conntrack.count) || 0;
        if (c <= 10000) throw new Error('kondisi sudah berubah: conntrack tinggal ' + c);
        step = { label: 'Bersihkan conntrack (' + c + ' koneksi)', op: 'conntrack-clear' }; label = step.label;
      } else throw new Error('kind belum didukung fix 1-langkah: ' + kind);
      const ticket = mkTicket({ kind: 'ai-plan', ip, title: label, steps: [step] });
      return send(res, 200, { ok: true, ticket, label: 'Yes: ' + label });
    }
    if (u.pathname === '/api/ai-plan-act' && req.method === 'POST') {
      const body = await new Promise((resolve, reject) => {
        let b = ''; req.on('data', c => { b += c; if (b.length > 200000) req.destroy(); });
        req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { reject(new Error('body bukan JSON')); } });
        req.on('error', reject);
      });
      const op = PENDING.get(body.ticket);
      if (!op || op.kind !== 'ai-plan') throw new Error('tiket rencana tidak valid / kedaluwarsa');
      const WU = (body.user && String(body.user).trim()) || process.env.W_USER || '';
      const WP = (body.pass !== undefined ? String(body.pass) : '') || process.env.W_PASS || '';
      if (!WU || !WP) return send(res, 200, { ok: false, needLogin: true, error: 'Eksekusi rencana butuh 1 login tulis.' });
      PENDING.delete(body.ticket);
      const pr = await runPlan(op.ip, WU, WP, op.steps || [], op.title || '');
      const lines = (pr.steps || []).map((x, i) => (x.ok ? 'PASS' : 'FAIL') + ' ' + (i + 1) + '. ' + x.label + (x.detail ? ' - ' + x.detail : ''));
      let reply = (pr.ok ? 'Rencana beres (' + pr.steps.length + ' langkah).' : 'Rencana berhenti: ' + pr.error) + ' ' + lines.join(' | ');
      if (pr.backupFile) reply += ' Backup: collector/backups/' + pr.backupFile;
      if (pr.rolledBack === true) reply += ' Rollback: perubahan dikembalikan.';
      else if (pr.rolledBack === false && !pr.ok) reply += ' WARNING rollback sebagian gagal.';
      return send(res, 200, { ok: pr.ok, reply, steps: pr.steps, rolledBack: pr.rolledBack, backupFile: pr.backupFile, error: pr.error || undefined });
    }
    if (u.pathname === '/api/ai-act' && req.method === 'POST') {
      const body = await new Promise((resolve, reject) => {
        let b = ''; req.on('data', c => { b += c; });
        req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { reject(new Error('body bukan JSON')); } });
        req.on('error', reject);
      });
      const op = PENDING.get(body.ticket);
      if (!op) throw new Error('tiket tidak valid / kedaluwarsa — minta lagi');
      const WU = (body.user && String(body.user).trim()) || process.env.W_USER || '';
      const WP = (body.pass !== undefined ? String(body.pass) : '') || process.env.W_PASS || '';
      if (!WU || !WP) return send(res, 200, { ok: false, needLogin: true, error: 'Aksi tulis butuh login device. Isi user + password tulis.' });
      PENDING.delete(body.ticket);
      if (op.kind === 'ai-plan') {
        const pr = await runPlan(op.ip, WU, WP, op.steps || [], op.title || '');
        const lines = (pr.steps || []).map((x, i) => (x.ok ? '✅' : '❌') + ' ' + (i + 1) + '. ' + x.label + (x.detail ? ' — ' + x.detail : ''));
        let reply = (pr.ok ? `✅ Rencana "${op.title || 'fix'}" beres (${pr.steps.length} langkah).` : `🔴 Rencana berhenti: ${pr.error}`) + '\n' + lines.join('\n');
        if (pr.backupFile) reply += '\n💾 Backup sebelum eksekusi: collector/backups/' + pr.backupFile;
        if (pr.rolledBack === true) reply += '\n↩ Perubahan yang sudah jalan DIKEMBALIKAN (rollback).';
        else if (pr.rolledBack === false && !pr.ok) reply += '\n⚠️ Rollback sebagian gagal — cek manual + pakai file backup.';
        return send(res, 200, { ok: pr.ok, reply, steps: pr.steps, rolledBack: pr.rolledBack, backupFile: pr.backupFile, error: pr.error || undefined });
      }
      if (op.kind === 'iface-disable') await rosQuery(op.ip, WU, WP, '/interface/set', { numbers: op.iface, disabled: 'yes' }, D.port);
      else if (op.kind === 'iface-enable') await rosQuery(op.ip, WU, WP, '/interface/set', { numbers: op.iface, disabled: 'no' }, D.port);
      else if (op.kind === 'ros-cmd') {
        // backup sebelum perubahan, lalu jalankan perintah yang sudah lolos allowlist
        const before = await rosExport(op.ip, WU, WP, D.port);
        const fs = require('fs'); try { fs.mkdirSync(__dirname + '/backups'); } catch {}
        fs.writeFileSync(__dirname + '/backups/pre-change-' + op.ip.replace(/\./g, '-') + '-' + Date.now() + '.rsc', before);
        const out = await rosQuery(op.ip, WU, WP, op.path, op.args || {}, D.port);
        return send(res, 200, { ok: true, reply: `✅ ${op.label} di ${op.ip} sudah dijalankan. Backup sebelum perubahan tersimpan di collector/backups/.`, out });
      }
      else throw new Error('aksi tidak dikenal');
      return send(res, 200, { ok: true, reply: `✅ ${op.iface} di ${op.ip} udah di-${op.kind === 'iface-disable' ? 'DISABLE' : 'ENABLE'}. Tercatat di log.` });
    }
    if (u.pathname === '/api/archify-file') {
      const name = String(q.name || '').replace(/[^a-zA-Z0-9\-.]/g, '');
      if (!name.endsWith('.html')) throw new Error('file tidak valid');
      const OUTDIR = process.env.ARCHIFY_OUT || 'C:/Users/ridwan/Documents/Default Project/archify-output';
      const p = OUTDIR + '/' + name;
      if (!require('fs').existsSync(p)) throw new Error('file tidak ada');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      return res.end(require('fs').readFileSync(p));
    }
    if (u.pathname === '/api/archify-export' && req.method === 'POST') {
      const body = await new Promise((resolve, reject) => {
        let b = ''; req.on('data', c => { b += c; if (b.length > 500000) req.destroy(); });
        req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { reject(new Error('body bukan JSON')); } });
        req.on('error', reject);
      });
      const nodes = body.nodes || [], links = body.links || [];
      if (!nodes.length) throw new Error('tidak ada node');
      const ARCHIFY = process.env.ARCHIFY_DIR || 'C:/Users/ridwan/.agents/skills/archify';
      const OUTDIR = process.env.ARCHIFY_OUT || 'C:/Users/ridwan/Documents/Default Project/archify-output';
      const fs = require('fs'); try { fs.mkdirSync(OUTDIR, { recursive: true }); } catch {}
      const TMAP = { internet: 'external', pc: 'frontend', ap: 'frontend', ont: 'frontend', server: 'backend', router: 'backend', switch: 'backend', swpoe: 'backend', firewall: 'security', olt: 'backend' };
      const seen = new Set();
      const cid = raw => {
        let s = String(raw || 'n').replace(/[^a-zA-Z0-9_-]/g, '-');
        if (/^[0-9-]/.test(s)) s = 'n' + s;
        let u = s, k = 2;
        while (seen.has(u)) u = s + '-' + (k++);
        seen.add(u); return u;
      };
      const idMap = {};
      const comps = nodes.map(n => {
        const id = cid(n.id);
        idMap[n.id] = id;
        return { id, _x: Number(n.x) || 0, _y: Number(n.y) || 0, type: TMAP[n.icon] || 'backend', label: String(n.label || id).slice(0, 48), sublabel: String(n.sub || '').slice(0, 80), tag: String(n.icon || 'node').slice(0, 24) };
      });
      // susun cerdas: chain -> baris ular, star -> radial (planar, minim silang)
      const deg = {};
      links.forEach(l => { const a = idMap[l[0]], b = idMap[l[1]]; if (!a || !b || a === b) return; deg[a] = (deg[a] || 0) + 1; deg[b] = (deg[b] || 0) + 1; });
      const adjL = {};
      comps.forEach(c => adjL[c.id] = []);
      links.forEach(l => { const a = idMap[l[0]], b = idMap[l[1]]; if (!a || !b || a === b) return; adjL[a].push(b); adjL[b].push(a); });
      const maxDeg = Math.max(0, ...comps.map(c => deg[c.id] || 0));
      if (maxDeg <= 2 && comps.length > 1) {
        // chain: jalan dari ujung, susun ular per 6 kolom
        let start = comps.find(c => (deg[c.id] || 0) === 1) || comps[0];
        const order = [], seenW = new Set([start.id]);
        order.push(start.id);
        for (;;) {
          const last = order[order.length - 1];
          const nx = (adjL[last] || []).find(x => !seenW.has(x));
          if (!nx) break;
          seenW.add(nx); order.push(nx);
        }
        comps.forEach(c => { if (!seenW.has(c.id)) order.push(c.id); });
        const COLS = 6, SX = 300, SY = 320;
        order.forEach((id, i) => {
          const r = Math.floor(i / COLS);
          let col = i % COLS;
          if (r % 2 === 1) col = COLS - 1 - col;
          const c = comps.find(x => x.id === id);
          c._x = col * SX; c._y = r * SY;
        });
      } else if (maxDeg === comps.length - 1 && comps.length > 2) {
        // star: hub tengah, satelit melingkar
        const hub = comps.find(c => (deg[c.id] || 0) === maxDeg);
        const rest = comps.filter(c => c.id !== hub.id);
        hub._x = 0; hub._y = 0;
        rest.forEach((c, i) => {
          const a = (2 * Math.PI * i) / rest.length;
          c._x = Math.round(Math.cos(a) * 420); c._y = Math.round(Math.sin(a) * 420);
        });
      }
      // normalisasi posisi ke viewBox dinamis (longgar untuk layer padat)
      const CW = 132, CH = 60;
      const VW = 1600, VH = 900, M = 180;
      const xs = comps.map(c => c._x), ys = comps.map(c => c._y);
      const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
      const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
      const sc = Math.min((VW - 2 * M - CW) / bw, (VH - 2 * M - CH) / bh);
      const components = comps.map(c => ({ id: c.id, type: c.type, label: c.label, sublabel: c.sublabel, tag: c.tag, pos: [Math.round(M + (c._x - minX) * sc), Math.round(M + (c._y - minY) * sc)], size: [CW, CH] }));
      // de-collision: gap besar antar kotak (stub rute butuh ruang)
      var ARCH_VB = [1100, 700];
      const tidy = (iters) => {
      for (let it = 0; it < (iters || 200); it++) {
        let moved = false;
        for (let i = 0; i < components.length; i++) for (let j = i + 1; j < components.length; j++) {
          const A = components[i], B = components[j];
          const dx = (B.pos[0] + CW / 2) - (A.pos[0] + CW / 2), dy = (B.pos[1] + CH / 2) - (A.pos[1] + CH / 2);
          const ox = (CW + 120) - Math.abs(dx), oy = (CH + 120) - Math.abs(dy);
          if (ox > 0 && oy > 0) {
            moved = true;
            if (ox < oy) { const s = dx === 0 ? 1 : Math.sign(dx), p = ox / 2 + 1; A.pos[0] = Math.round(A.pos[0] - s * p); B.pos[0] = Math.round(B.pos[0] + s * p); }
            else { const s = dy === 0 ? 1 : Math.sign(dy), p = oy / 2 + 1; A.pos[1] = Math.round(A.pos[1] - s * p); B.pos[1] = Math.round(B.pos[1] + s * p); }
          }
        }
        if (!moved) break;
      }
      // re-fit viewBox mengikuti hasil sebar
      const rx = components.map(c => c.pos[0]), ry = components.map(c => c.pos[1]);
      const rminX = Math.min(...rx), rminY = Math.min(...ry);
      const rmaxX = Math.max(...rx), rmaxY = Math.max(...ry);
      const MG = 60;
      components.forEach(c => { c.pos[0] += MG - rminX; c.pos[1] += MG - rminY; });
      // viewBox minimum skema 320x240, node dirata-tengah kalau kanvas longgar
      ARCH_VB = [Math.max(320, Math.ceil(rmaxX - rminX + CW + MG * 2)), Math.max(240, Math.ceil(rmaxY - rminY + CH + MG * 2))];
      const cxSh = Math.round((ARCH_VB[0] - (rmaxX - rminX + CW)) / 2) - MG;
      const cySh = Math.round((ARCH_VB[1] - (rmaxY - rminY + CH)) / 2) - MG;
      if (cxSh !== 0 || cySh !== 0) components.forEach(c => { c.pos[0] += cxSh; c.pos[1] += cySh; });
      };
      tidy(200);
      const labelDyMap = {};
      const buildConns = () => {
      const centers = {};
      components.forEach(c => { centers[c.id] = [c.pos[0] + CW / 2, c.pos[1] + CH / 2]; });
      const conns = [];
      links.forEach((l, i) => {
        const [a, b, med, pa, pb] = l;
        if (!idMap[a] || !idMap[b]) return;
        const c = { id: 'link-' + (i + 1), from: idMap[a], to: idMap[b] };
        const lbl = [pa, pb].filter(Boolean).join(' ↔ ').slice(0, 60);
        if (lbl) c.label = lbl;
        if (med === 'fo') c.variant = 'emphasis';
        const [fx, fy] = centers[c.from], [tx, ty] = centers[c.to];
        const dx = tx - fx, dy = ty - fy;
        // sisi = sisi yang saling menghadap (sesuai router otomatis)
        const ang = Math.atan2(dy, dx) * 180 / Math.PI;
        let fs, ts;
        if (ang >= -45 && ang <= 45) { fs = 'right'; ts = 'left'; }
        else if (ang > 45 && ang < 135) { fs = 'bottom'; ts = 'top'; }
        else if (ang >= 135 || ang <= -135) { fs = 'left'; ts = 'right'; }
        else { fs = 'top'; ts = 'bottom'; }
        c.fromSide = fs; c.toSide = ts;
        c._pref = [fs, ts];
        // CATATAN: router archify mengabaikan via dan me-route otomatis dari sisi.
        // Satu-satunya tuas anti-tabrakan = posisi node (force layout + gap besar).
        conns.push(c);
      });
      // seimbangkan link per sisi per node (maks 2/sisi) biar port tidak geser jauh
      const CAP = 2;
      const sorder = ['top', 'right', 'bottom', 'left'];
      const byNode = {};
      conns.forEach(c => {
        [[c.from, 0], [c.to, 1]].forEach(([nid, end]) => {
          (byNode[nid] = byNode[nid] || []).push({ c, end });
        });
      });
      for (const nid of Object.keys(byNode)) {
        const cnt = { top: 0, right: 0, bottom: 0, left: 0 };
        for (const it of byNode[nid]) {
          const pref = it.end === 0 ? it.c._pref[0] : it.c._pref[1];
          const adj = [pref, sorder[(sorder.indexOf(pref) + 1) % 4], sorder[(sorder.indexOf(pref) + 3) % 4]];
          const pick = adj.find(s => cnt[s] < CAP) || adj.slice().sort((a, b) => cnt[a] - cnt[b])[0];
          cnt[pick]++;
          if (it.end === 0) it.c.fromSide = pick; else it.c.toSide = pick;
        }
      }
      conns.forEach(c => { delete c._pref; if (labelDyMap[c.id]) c.labelDy = labelDyMap[c.id]; });
      return conns;
      };
      const layerLabel = String(body.layer || 'topologi').slice(0, 80);
      const buildTag = 'build-' + Date.now().toString(36);
      const fo = links.filter(l => l[2] === 'fo').length;
      const slug = layerLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30) || 'topo';
      const ts = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
      const base = 'netmon-' + slug + '-' + ts;
      const candPath = OUTDIR + '/' + base + '.architecture.json';
      const htmlPath = OUTDIR + '/' + base + '.html';
      const { execFile } = require('child_process');
      const run = (args) => new Promise(resolve => execFile('node', ['bin/archify.mjs', ...args], { cwd: ARCHIFY, timeout: 120000 }, (e, stdout, stderr) => resolve({ code: e ? (e.code || 1) : 0, out: String(stdout || ''), err: String(stderr || '').slice(0, 500) })));
      const labelFixCount = {};
      let candidate = null, conns = null, v = null, validation = null, profile = 'showcase';
      for (let round = 0; round < 6; round++) {
        conns = buildConns();
        candidate = {
          schema_version: 1, diagram_type: 'architecture',
          meta: { title: String(body.title || ('Topologi ' + layerLabel)).slice(0, 120), quality_profile: 'showcase', viewBox: ARCH_VB },
          components, boundaries: [{ kind: 'region', label: layerLabel, wraps: components.map(c => c.id) }],
          connections: conns,
          cards: [{ dot: 'cyan', title: layerLabel, items: [components.length + ' perangkat', conns.length + ' link', 'FO: ' + fo + ' • LAN: ' + (conns.length - fo), buildTag] }],
        };
        fs.writeFileSync(candPath, JSON.stringify(candidate, null, 1));
        v = await run(['validate', 'architecture', candPath, '--quality', 'showcase', '--json']);
        validation = v.out;
        try { validation = JSON.parse(v.out); } catch {}
        if (v.code === 0) { profile = 'showcase'; break; }
        const diags = (validation && validation.diagnostics) || [];
        const edge = diags.find(d => d.code === 'clean-flow/edge-through-node' && d.evidence && d.evidence.obstacleId);
        const lab = diags.find(d => d.code === 'composition/label-route-clearance' && d.subject && d.subject.id);
        if (edge && round < 5) {
          // geser node penghalang menjauhi segmen (150px tegak lurus)
          const n = components.find(x => x.id === edge.evidence.obstacleId);
          const ev = edge.evidence;
          if (n && ev.from && ev.to) {
            const mx = (ev.from[0] + ev.to[0]) / 2, my = (ev.from[1] + ev.to[1]) / 2;
            let vx = (n.pos[0] + CW / 2) - mx, vy = (n.pos[1] + CH / 2) - my;
            const m = Math.hypot(vx, vy) || 1; vx /= m; vy /= m;
            n.pos[0] = Math.round(n.pos[0] + vx * 100); n.pos[1] = Math.round(n.pos[1] + vy * 100);
            tidy(80);
            continue;
          }
        }
        if (lab && round < 5) {
          const k = (labelFixCount[lab.subject.id] = (labelFixCount[lab.subject.id] || 0) + 1);
          if (k === 1) labelDyMap[lab.subject.id] = 24;
          else if (k === 2) labelDyMap[lab.subject.id] = -24;
          else { const cc = conns.find(x => x.id === lab.subject.id); if (cc) delete cc.label; }
          continue;
        }
        break;
      }
      if (v.code !== 0) {
        // showcase tidak lolos → coba profil standard (dense map), tetap jujur di respons
        candidate.meta.quality_profile = 'standard';
        fs.writeFileSync(candPath, JSON.stringify(candidate, null, 1));
        v = await run(['validate', 'architecture', candPath, '--quality', 'standard', '--json']);
        try { validation = JSON.parse(v.out); } catch { validation = v.out.slice(0, 2000); }
        if (v.code === 0) profile = 'standard';
      }
      if (v.code !== 0) return send(res, 200, { ok: false, error: 'validasi gagal', validation, log: v.err });
      const d = await run(['deliver', 'architecture', candPath, htmlPath, '--quality', profile, '--json']);
      if (d.code !== 0) return send(res, 200, { ok: false, error: 'deliver gagal', log: (d.out + d.err).slice(0, 2000) });
      return send(res, 200, { ok: true, profile, file: base + '.html', url: '/api/archify-file?name=' + base + '.html', validation });
    }
    if (u.pathname === '/api/backup-file') {
      const name = String(q.name || '').replace(/[^a-zA-Z0-9\-.]/g, '');
      if (!name.endsWith('.rsc')) throw new Error('file tidak valid');
      const fs = require('fs');
      const p = __dirname + '/backups/' + name;
      if (!fs.existsSync(p)) throw new Error('file tidak ada');
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="' + name + '"', 'Access-Control-Allow-Origin': '*' });
      return res.end(fs.readFileSync(p));
    }
    if (u.pathname === '/api/discover') return send(res, 200, await discover(q));
    if (u.pathname === '/api/traffic') return send(res, 200, await traffic(q));
    if (u.pathname === '/api/status') {
      const ip = q.ip, user = q.user || D.user, pass = q.pass || D.pass;
      if (!ip) throw new Error('param ip wajib');
      const ifs = await rosQuery(ip, user, pass, '/interface/print', { '.proplist': 'name,disabled,running,type' }, D.port);
      return send(res, 200, { ok: true, ip, via: 'routeros-api', ifaces: ifs.map(i => ({ name: i.name, admin: i.disabled === 'true' ? 'down' : 'up', oper: i.running === 'true' ? 'up' : 'down', type: i.type })) });
    }
    if (u.pathname === '/api/gns3') {
      // proxy ke GNS3 server (browser kena CORS kalau langsung). path wajib /v2/...
      const server = String(q.server || 'http://localhost:3080').replace(/\/$/, '');
      const p = String(q.path || '/v2/projects');
      if (!p.startsWith('/v2/') || p.includes('..')) throw new Error('path GNS3 tidak valid');
      const headers = {};
      if (q.user) headers.Authorization = 'Basic ' + Buffer.from(String(q.user) + ':' + String(q.pass || '')).toString('base64');
      const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 25000);
      try {
        const r = await fetch(server + p, { headers, signal: ctl.signal });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error((j.message || j.error) ? String(j.message || j.error).slice(0, 120) : 'GNS3 error ' + r.status);
        return send(res, 200, { ok: true, data: j });
      } finally { clearTimeout(to); }
    }
    if (u.pathname === '/api/dhcp') {
      const pools = await rosQuery(q.ip, q.user || D.user, q.pass || D.pass, '/ip/pool/print', {}, D.port);
      return send(res, 200, { ok: true, pools });
    }
    if (u.pathname === '/api/conntrack') {
      const s = await rosQuery(q.ip, q.user || D.user, q.pass || D.pass, '/ip/firewall/connection/tracking/get', {}, D.port);
      const c = await rosQuery(q.ip, q.user || D.user, q.pass || D.pass, '/ip/firewall/connection/print', { 'count-only': '' }, D.port);
      return send(res, 200, { ok: true, tracking: s[0] || {}, count: c });
    }
    if (u.pathname === '/api/neighbors') {
      if (!q.ip) throw new Error('param ip wajib');
      const user = q.user || D.user, pass = q.pass || D.pass, community = q.community || D.community;
      try {
        const nb = await rosQuery(q.ip, user, pass, '/ip/neighbor/print', {}, D.port);
        return send(res, 200, { ok: true, via: 'routeros-api', ip: q.ip, neighbors: nb.map(n => ({ mac: n['mac-address'] || '', ip: n.address || '', identity: n.identity || '', iface: n.interface || '', version: n.version || '' })) });
      } catch (eApi) {
        const rows = await snmpq.subtree(q.ip, community, '1.3.6.1.2.1.4.22.1.2');
        const ifs = await snmpq.ifaces(q.ip, community);
        const descr = idx => (ifs.find(i => i.idx === Number(idx)) || {}).descr || ('if' + idx);
        return send(res, 200, { ok: true, via: 'snmp-arp', ip: q.ip, apiError: String(eApi.message || eApi), neighbors: rows.map(r => {
          const parts = r.oid.split('.').slice(-5); const mac = r.value.split(':').map(h => h.padStart(2, '0')).join(':').toUpperCase();
          return { mac, ip: parts.slice(1).join('.'), identity: '', iface: descr(parts[0]), version: '' };
        }) });
      }
    }
    if (u.pathname === '/api/ping') {
      if (!q.ip) throw new Error('param ip wajib');
      const { execFile } = require('child_process');
      const win = process.platform === 'win32';
      const args = win ? ['-n', '1', '-w', '2000', q.ip] : ['-c', '1', '-W', '2', q.ip];
      const out = await new Promise(resolve => execFile('ping', args, { timeout: 6000 }, (e, stdout) => resolve({ e, stdout: String(stdout || '') })));
      const m = out.stdout.match(/time[=<](\d+)\s*ms/i);
      const ok = /TTL=|ttl=|bytes (from|von)/i.test(out.stdout);
      return send(res, 200, { ok, ip: q.ip, ms: m ? Number(m[1]) : null, raw: out.stdout.split('\n').slice(-3).join(' ').slice(0, 120) });
    }
    if (u.pathname === '/api/host') return send(res, 200, await hostInfo());
    if (u.pathname === '/api/host-traffic') return send(res, 200, await hostTraffic(q.iface));
    if (u.pathname === '/api/localnets') {
      const os = require('os');
      const nets = [];
      for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
        for (const a of (addrs || [])) {
          if (a.family !== 'IPv4' || a.internal || !a.address) continue;
          const p = a.address.split('.');
          if (p.length !== 4) continue;
          nets.push({ if: name, ip: a.address, cidr: p.slice(0, 3).join('.') + '.0/24' });
        }
      }
      return send(res, 200, { ok: true, nets });
    }
    if (u.pathname === '/api/snmpstat') {
      // ala PRTG: sekali panggil = semua interface + rate + CPU + RAM (butuh SNMP tembus)
      const ip = q.ip, community = q.community || D.community;
      if (!ip) throw new Error('param ip wajib');
      const t0 = Date.now();
      const a = await snmpq.ifacesFast(ip, community);
      await sleep(1500);
      const b = await snmpq.ifacesFast(ip, community);
      const dt = Math.max(0.8, (Date.now() - t0) / 1000);
      const bm = Object.fromEntries(b.map(i => [i.idx, i]));
      const diff = (x, y) => { let d = y - x; if (d < 0) d += 4294967296; return d; };
      const ifaces = a.filter(i => i.descr).map(i => {
        const n = bm[i.idx] || i;
        return { name: i.descr, admin: n.admin, oper: n.oper, dlMbps: +(diff(i.inOct, n.inOct) * 8 / dt / 1e6).toFixed(2), ulMbps: +(diff(i.outOct, n.outOct) * 8 / dt / 1e6).toFixed(2) };
      });
      let cpu = null, memPct = null;
      try {
        const loads = await snmpq.subtree(ip, community, '1.3.6.1.2.1.25.3.3.1.2');
        const vals = loads.map(r => Number(r.value)).filter(v => !isNaN(v));
        if (vals.length) cpu = Math.round(vals.reduce((x, y) => x + y, 0) / vals.length);
      } catch {}
      try {
        const cells = await snmpq.walk(ip, community, '1.3.6.1.2.1.25.2.3.1');
        const rows = {};
        for (const c of cells) (rows[c.idx] = rows[c.idx] || {})[c.col] = c.value;
        for (const idx of Object.keys(rows)) {
          const r = rows[idx];
          if (/physical|real memory|memory/i.test(r['3'] || '') && Number(r['5']) > 0) {
            memPct = Math.round(100 * Number(r['6'] || 0) * Number(r['4'] || 0) / (Number(r['5']) * Number(r['4'] || 0)));
            break;
          }
        }
      } catch {}
      return send(res, 200, { ok: true, ip, ifaces, cpu, memPct });
    }
    if (u.pathname === '/api/netscan') {      const net = String(q.net || '');
      const m = net.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.0\/24$/);
      if (!m || m.slice(1).some(o => +o > 255)) throw new Error('param net harus /24, cth: 192.168.18.0/24');
      const base = m[1] + '.' + m[2] + '.' + m[3] + '.';
      const os = require('os');
      const own = new Set();
      for (const addrs of Object.values(os.networkInterfaces())) for (const a of (addrs || [])) if (a.family === 'IPv4' && a.address) own.add(a.address);
      const { execFile } = require('child_process');
      const pingOne = ip => new Promise(resolve => {
        execFile('ping', ['-n', '1', '-w', '800', ip], { timeout: 3000 }, (err, stdout) => resolve(/TTL=\d+/i.test(String(stdout || '')) ? ip : null));
      });
      const ips = []; for (let i = 1; i < 255; i++) { const ip = base + i; if (!own.has(ip)) ips.push(ip); }
      const alive = [];
      for (let i = 0; i < ips.length; i += 64) {
        const batch = await Promise.all(ips.slice(i, i + 64).map(pingOne));
        batch.forEach(x => { if (x) alive.push(x); });
      }
      // ala Advanced IP Scanner: baca tabel ARP (nangkep host yang ping-nya diblokir) + MAC
      const arpMac = {};
      try {
        const arpOut = await new Promise(resolve => execFile(process.platform === 'win32' ? 'arp' : 'arp', process.platform === 'win32' ? ['-a'] : ['-an'], { timeout: 8000 }, (e, stdout) => resolve(String(stdout || ''))));
        const re = new RegExp(m[1] + '\\.' + m[2] + '\\.' + m[3] + '\\.(\\d+)\\s+([0-9a-fA-F:-]{11,17})', 'g');
        let am;
        while ((am = re.exec(arpOut)) !== null) {
          const ip = base + am[1];
          if (!own.has(ip) && am[1] !== '0' && am[1] !== '255') arpMac[ip] = am[2].replace(/-/g, ':').toUpperCase();
        }
      } catch {}
      const allIps = [...new Set([...alive, ...Object.keys(arpMac)])];
      const revDns = async ip => {
        try {
          const names = await Promise.race([
            require('dns').promises.reverse(ip),
            new Promise((_, rej) => setTimeout(() => rej(new Error('t/o')), 1500)),
          ]);
          return (names && names[0]) || '';
        } catch { return ''; }
      };
      const probe = (ip, port) => new Promise(resolve => {
        let done = false; const fin = v => { if (!done) { done = true; try { s.destroy(); } catch {} resolve(v); } };
        const s = require('net').connect(port, ip);
        const t = setTimeout(() => fin(false), 1200);
        s.on('connect', () => { clearTimeout(t); fin(true); });
        s.on('error', () => { clearTimeout(t); fin(false); });
      });
      const hosts = [];
      let comms = String(q.communities || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 8);
      comms = [...comms, 'public', 'private', 'netmon'].filter((v, i, a) => a.indexOf(v) === i);
      const snmpProbe = async ip => {
        const tr = cm => snmpq.get(ip, cm, [snmpq.OIDS.sysDescr, snmpq.OIDS.sysName], 1200, 0).then(sys => {
          const gd = oid => (sys.find(v => v.oid === oid) || {}).value || '';
          const descr = gd(snmpq.OIDS.sysDescr);
          return descr ? { community: cm, sysDescr: descr.slice(0, 120), sysName: gd(snmpq.OIDS.sysName).slice(0, 64) } : null;
        }).catch(() => null);
        const rs = await Promise.all(comms.map(tr));
        return rs.find(Boolean) || null;
      };
      const work = async ip => {
        const [api, winbox, ssh, telnet, http, snmp, name] = await Promise.all([probe(ip, 8728), probe(ip, 8291), probe(ip, 22), probe(ip, 23), probe(ip, 80), snmpProbe(ip), revDns(ip)]);
        return { ip, mac: arpMac[ip] || '', name, ping: alive.includes(ip), ports: [api && '8728-API', winbox && '8291-Winbox', ssh && '22-SSH', telnet && '23-Telnet', http && '80-HTTP'].filter(Boolean), snmp };
      };
      for (let i = 0; i < allIps.length; i += 16) {
        hosts.push(...await Promise.all(allIps.slice(i, i + 16).map(work)));
      }
      return send(res, 200, { ok: true, net, count: hosts.length, hosts });
    }
    if (u.pathname === '/api/topo' && req.method === 'GET') {
      const fs = require('fs'), path = require('path');
      const f = path.join(__dirname, '..', 'data', 'topo.json');
      const fb = f + '.bak';
      const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
      try {
        if (!fs.existsSync(f)) return send(res, 200, { ok: true, cur: null, layers: {}, empty: true });
        try { const d = read(f); return send(res, 200, { ok: true, cur: d.cur || null, layers: d.layers || {}, at: d.at || null }); }
        catch (eBad) {
          const d = read(fb);
          return send(res, 200, { ok: true, cur: d.cur || null, layers: d.layers || {}, at: d.at || null, recovered: 'bak' });
        }
      } catch (e) { return send(res, 500, { ok: false, error: 'topo rusak (file + backup): ' + String(e.message || e).slice(0, 100) }); }
    }
    if (u.pathname === '/api/topo' && req.method === 'POST') {
      const body = await new Promise((resolve, reject) => {
        let b = ''; req.on('data', c => { b += c; if (b.length > 5000000) req.destroy(); });
        req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { reject(new Error('body bukan JSON')); } });
        req.on('error', reject);
      });
      const layers = body.layers;
      if (!layers || typeof layers !== 'object') throw new Error('layers wajib objek');
      for (const k of Object.keys(layers)) {
        const L = layers[k];
        if (!L || !Array.isArray(L.nodes) || !Array.isArray(L.links)) throw new Error('layer rusak: ' + k);
      }
      const fs = require('fs'), path = require('path');
      const dir = path.join(__dirname, '..', 'data');
      try { fs.mkdirSync(dir, { recursive: true }); } catch {}
      const f = path.join(dir, 'topo.json');
      if (fs.existsSync(f)) try { fs.copyFileSync(f, f + '.bak'); } catch {}
      const at = new Date().toISOString();
      fs.writeFileSync(f, JSON.stringify({ at, cur: body.cur || null, layers }, null, 1));
      return send(res, 200, { ok: true, at });
    }
    if ((u.pathname === '/' || u.pathname === '/index.html') && req.method === 'GET') {
      const fs = require('fs'), path = require('path');
      const p = path.join(__dirname, '..', 'index.html');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      return res.end(fs.readFileSync(p));
    }
    if (u.pathname === '/api/ports') {
      // probe cepat port remote-management: 22 SSH, 23 Telnet, 80/443 Web, 8291 Winbox, 8728 API
      const ip = q.ip;
      if (!ip) throw new Error('param ip wajib');
      const probe = (port, ms) => new Promise(resolve => {
        let done = false; const fin = v => { if (!done) { done = true; try { s.destroy(); } catch {} resolve(v); } };
        const s = require('net').connect(port, ip);
        const t = setTimeout(() => fin(false), ms || 900);
        s.on('connect', () => { clearTimeout(t); fin(true); });
        s.on('error', () => { clearTimeout(t); fin(false); });
      });
      const [ssh, telnet, http, https, winbox, api] = await Promise.all([
        probe(22), probe(23), probe(80), probe(443), probe(8291), probe(8728),
      ]);
      return send(res, 200, { ok: true, ip, ports: { ssh, telnet, http, https, winbox, api } });
    }
    return send(res, 404, { ok: false, error: 'unknown endpoint' });
  } catch (e) { send(res, 500, { ok: false, error: String(e.message || e) }); }
});
server.listen(PORT, () => console.log('netmon-collector on :' + PORT));
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e && e.message || e));
process.on('uncaughtException', e => console.error('[uncaughtException]', e && e.message || e));


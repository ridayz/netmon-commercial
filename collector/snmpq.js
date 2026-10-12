// Wrapper SNMP v2c cepat pakai net-snmp (promisified).
const snmp = require('net-snmp');

const OIDS = {
  sysDescr: '1.3.6.1.2.1.1.1.0',
  sysName: '1.3.6.1.2.1.1.5.0',
  sysUpTime: '1.3.6.1.2.1.1.3.0',
  ifNumber: '1.3.6.1.2.1.2.1.0',
  ifTable: '1.3.6.1.2.1.2.2.1', // .2=descr .7=admin .8=oper .10=inOct .16=outOct .13=discards...
};

function session(ip, community, timeout = 3000, retries = 1) {
  return snmp.createSession(ip, community, { timeout, retries, version: snmp.Version2c });
}
function get(ip, community, oids, timeout, retries) {
  return new Promise((res, rej) => {
    const s = session(ip, community, timeout || 3000, retries === undefined ? 1 : retries);
    s.get(oids, (e, vb) => { s.close(); e ? rej(e) : res(vb.map(v => ({ oid: v.oid, type: snmp.ObjectType[v.type], value: String(v.value) }))); });
  });
}
function walk(ip, community, base) {
  return new Promise((res, rej) => {
    const s = session(ip, community);
    const out = [];
    const maxRep = 20;
    function cb(e, table) {
      s.close();
      if (e) return rej(e);
      for (const idx of Object.keys(table)) for (const col of Object.keys(table[idx])) {
        const cell = table[idx][col];
        out.push({ idx, col, type: snmp.ObjectType[cell.type], value: String(cell.value) });
      }
      res(out);
    }
    s.table(base, maxRep, cb);
  });
}
function subtree(ip, community, base) {
  return new Promise((res, rej) => {
    const s = session(ip, community);
    const out = [];
    const t = setTimeout(() => { try { s.close(); } catch {} rej(new Error('snmp walk timeout ' + base)); }, 12000);
    s.subtree(base, 20, vb => {
      vb.forEach(v => { if (snmp.isVarbindError(v)) return; out.push({ oid: v.oid, value: String(v.value) }); });
    }, e => { clearTimeout(t); try { s.close(); } catch {} e ? rej(e) : res(out); });
  });
}
async function ifaces(ip, community) {
  const cols = { descr: '2', admin: '7', oper: '8', inOct: '10', outOct: '16' };
  const byIdx = {};
  for (const [k, col] of Object.entries(cols)) {
    const rows = await subtree(ip, community, OIDS.ifTable + '.' + col);
    for (const r of rows) {
      const idx = r.oid.split('.').pop();
      (byIdx[idx] = byIdx[idx] || {})[k] = r.value;
    }
  }
  return Object.entries(byIdx).map(([idx, c]) => ({
    idx: Number(idx), descr: c.descr || '', admin: c.admin === '1' ? 'up' : 'down',
    oper: c.oper === '1' ? 'up' : 'down', inOct: Number(c.inOct || 0), outOct: Number(c.outOct || 0),
  }));
}
// 1x walk untuk seluruh ifTable (jauh lebih cepat dari 5x subtree)
async function ifacesFast(ip, community) {
  const cells = await walk(ip, community, OIDS.ifTable);
  const byIdx = {};
  const colName = { 2: 'descr', 7: 'admin', 8: 'oper', 10: 'inOct', 16: 'outOct' };
  for (const c of cells) {
    if (!colName[c.col]) continue;
    (byIdx[c.idx] = byIdx[c.idx] || {})[colName[c.col]] = c.value;
  }
  return Object.entries(byIdx).map(([idx, c]) => ({
    idx: Number(idx), descr: c.descr || '', admin: c.admin === '1' ? 'up' : 'down',
    oper: c.oper === '1' ? 'up' : 'down', inOct: Number(c.inOct || 0), outOct: Number(c.outOct || 0),
  }));
}
module.exports = { OIDS, get, walk, subtree, ifaces, ifacesFast };

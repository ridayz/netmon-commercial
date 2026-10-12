// RouterOS API client murni Node (tanpa dependensi).
// Protokol: tiap kata diawali length (1-4 byte), kalimat diakhiri kata kosong.
const net = require('net');

function encLen(n) {
  if (n < 0x80) return Buffer.from([n]);
  if (n < 0x4000) return Buffer.from([(n >> 8) | 0x80, n & 0xff]);
  if (n < 0x200000) return Buffer.from([(n >> 16) | 0xc0, (n >> 8) & 0xff, n & 0xff]);
  return Buffer.from([0xe0 | (n >>> 24), (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
}
function encWord(s) { const b = Buffer.from(s, 'utf8'); return Buffer.concat([encLen(b.length), b]); }

class RosApi {
  constructor(host, port = 8728, timeout = 5000) { this.host = host; this.port = port; this.timeout = timeout; }
  connect() {
    return new Promise((res, rej) => {
      this.sock = net.connect(this.port, this.host);
      this.sock.on('error', () => { try { this.sock.destroy(); } catch {} });
      this.buf = Buffer.alloc(0); this.queue = []; this.sent = []; this.waiters = [];
      const t = setTimeout(() => rej(new Error('connect timeout ' + this.host)), this.timeout);
      this.sock.on('connect', () => { clearTimeout(t); res(); });
      this.sock.on('error', e => rej(e));
      this.sock.on('data', d => { this.buf = Buffer.concat([this.buf, d]); this.pump(); });
    });
  }
  decLen() {
    if (!this.buf.length) return null;
    const b0 = this.buf[0];
    let n, len;
    if ((b0 & 0x80) === 0) { n = b0; len = 1; }
    else if ((b0 & 0xc0) === 0x80) { if (this.buf.length < 2) return null; n = ((b0 & 0x3f) << 8) | this.buf[1]; len = 2; }
    else if ((b0 & 0xe0) === 0xc0) { if (this.buf.length < 3) return null; n = ((b0 & 0x1f) << 16) | (this.buf[1] << 8) | this.buf[2]; len = 3; }
    else { if (this.buf.length < 4) return null; n = ((b0 & 0x0f) << 24) | (this.buf[1] << 16) | (this.buf[2] << 8) | this.buf[3]; len = 4; }
    return { n, len };
  }
  pump() {
    for (;;) {
      const L = this.decLen(); if (!L) return;
      if (this.buf.length < L.len + L.n) return;
      const word = this.buf.slice(L.len, L.len + L.n).toString('utf8');
      this.buf = this.buf.slice(L.len + L.n);
      if (word === '') { this.sent.push(this.queue); this.queue = []; }
      else this.queue.push(word);
      this.drain();
    }
  }
  drain() { while (this.sent.length && this.waiters.length) this.waiters.shift()(this.sent.shift()); }
  talk(words) {
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('api timeout')), this.timeout);
      this.waiters.push(s => { clearTimeout(t); res(s); });
      if (words && words.length) this.sock.write(Buffer.concat([...words.map(encWord), Buffer.from([0x00])]));
      this.drain();
    });
  }
  static parse(sent) {
    const out = { type: sent[0] || '', attrs: {}, list: [] };
    for (const w of sent.slice(1)) {
      const m = w.match(/^([=.!])([^=]*)=(.*)$/s) || w.match(/^([=.!])([^=]*)$/);
      if (!m) continue;
      if (m[1] === '=' && m[3] !== undefined) out.attrs[m[2]] = m[3];
      else if (m[1] === '.') out.list.push({ tag: m[2], id: m[3] });
      else out.attrs[w] = true;
    }
    return out;
  }
  async command(path, params = {}) {
    const words = [path, ...Object.entries(params).map(([k, v]) => `=${k}=${v}`)];
    const replies = [];
    // kumpulkan sampai !done
    const collect = async () => {
      const s = await this.talk(words.splice(0, words.length));
      replies.push(s);
      const p = RosApi.parse(s);
      if (p.type === '!done' || p.type === '!fatal') return replies;
      return collect();
    };
    return collect();
  }
  // mentah: kembalikan kalimat per kalimat (buat /export yang outputnya baris teks)
  async rawSentences(words) {
    const out = [];
    let s = await this.talk(words);
    for (;;) {
      out.push(s);
      const t = s[0] || '';
      if (t === '!done' || t === '!fatal') return out;
      if (t === '!trap') throw new Error('trap: ' + s.slice(1).join(' '));
      s = await this.talk(null);
    }
  }
  close() { try { this.sock.destroy(); } catch {} }
}

async function rosQuery(host, user, password, path, params = {}, port = 8728) {
  const api = new RosApi(host, port);
  await api.connect();
  try {
    const login = await api.talk(['/login', `=name=${user}`, `=password=${password}`]);
    const lp = RosApi.parse(login);
    if (lp.type === '!trap' || lp.type === '!fatal') throw new Error('login gagal: ' + JSON.stringify(lp.attrs));
    const out = [];
    const grab = async (first) => {
      let s = first;
      for (;;) {
        const p = RosApi.parse(s);
        if (p.type === '!re') out.push(p.attrs);
        if (p.type === '!done') return out;
        if (p.type === '!trap') throw new Error('trap: ' + JSON.stringify(p.attrs));
        if (p.type === '!fatal') throw new Error('fatal');
        s = await api.talk(null);
      }
    };
    const words = [path, ...Object.entries(params).map(([k, v]) => `=${k}=${v}`)];
    return grab(await api.talk(words));
  } finally { api.close(); }
}

module.exports = { RosApi, rosQuery };

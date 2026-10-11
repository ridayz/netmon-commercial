import fs from 'node:fs';
const j = JSON.parse(fs.readFileSync('C:/Users/ridwan/GNS3/projects/57ca78d2-7839-4178-8064-e2df11b1a80b/LAB-SPINE-LEAF.gns3', 'utf8'));
const keep = j.topology.nodes.filter(n => /^(LEAF|SPINE)/i.test(n.name || ''));
const keepIds = new Set(keep.map(n => n.node_id));
const leafs = keep;
const ports = {};
j.topology.links.forEach(l => { (l.nodes || []).forEach(e => {
  const t = (e.label && e.label.text) || ('eth' + (e.adapter_number || 0) + '/' + (e.port_number || 0));
  (ports[e.node_id] = ports[e.node_id] || []).push(t);
}); });
const W = 900, H = 400, pad = 140;
const xs = leafs.map(n => Number(n.x || 0)), ys = leafs.map(n => Number(n.y || 0));
const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
const sc = Math.min((W - pad * 2) / Math.max(1, maxX - minX), (H - pad * 2) / Math.max(1, maxY - minY), 1.2);
const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
const key = 'gleaf';
const idMap = {};
// layout two-tier rapi: spine di atas, leaf di bawah, sejajar
const spines = leafs.filter(n => /^SPINE/i.test(n.name)).sort((a, b) => a.name.localeCompare(b.name));
const onlyLeafs = leafs.filter(n => !/^SPINE/i.test(n.name)).sort((a, b) => a.name.localeCompare(b.name));
const pos = {};
spines.forEach((n, i) => { pos[n.node_id] = { x: Math.round(900 * (i + 1) / (spines.length + 1)), y: 110 }; });
onlyLeafs.forEach((n, i) => { pos[n.node_id] = { x: Math.round(900 * (i + 1) / (onlyLeafs.length + 1)), y: 290 }; });
const nodes = leafs.map((n, i) => {
  const id = (/^SPINE/i.test(n.name) ? 'spine-' : 'leaf-') + (i + 1) + '-' + key;
  idMap[n.node_id] = id;
  return {
    id,
    icon: 'switch',
    label: n.name,
    sub: ((ports[n.node_id] || []).slice(0, 2).join(' • ') || n.node_type || '').slice(0, 40),
    x: pos[n.node_id].x,
    y: pos[n.node_id].y,
    st: 'ok', gns: n.node_id,
  };
});
const links = [];
j.topology.links.forEach(l => {
  const eps = (l.nodes || []).filter(e => keepIds.has(e.node_id));
  if (eps.length < 2) return;
  // label link pendek (port saja, misal e1↔e1) — IP lengkap sudah ada di sub-teks node
  const pl = e => String((e.label && e.label.text) || ('eth' + (e.adapter_number || 0) + '/' + (e.port_number || 0))).split(' ')[0];
  links.push([idMap[eps[0].node_id], idMap[eps[1].node_id], 'fo', pl(eps[0]), pl(eps[1])]);
});
const out = { layers: { [key]: { label: 'GNS3: LEAF + SPINE', vb: '0 0 900 400', areas: [], nodes, links } } };
fs.writeFileSync('gns3-leaf-import.json', JSON.stringify(out, null, 1));
console.log('nodes:', nodes.length, '| links:', links.length);

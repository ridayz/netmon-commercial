import fs from 'node:fs';
const j = JSON.parse(fs.readFileSync('C:/Users/ridwan/GNS3/projects/57ca78d2-7839-4178-8064-e2df11b1a80b/LAB-SPINE-LEAF.gns3', 'utf8'));
const leafs = j.topology.nodes.filter(n => /^LEAF/i.test(n.name || ''));
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
const nodes = leafs.map((n, i) => ({
  id: 'leaf-' + (i + 1) + '-' + key,
  icon: 'switch',
  label: n.name,
  sub: ((ports[n.node_id] || []).slice(0, 2).join(' • ') || n.node_type || '').slice(0, 40),
  x: Math.round(W / 2 + (Number(n.x || 0) - cx) * sc),
  y: Math.round(H / 2 + (Number(n.y || 0) - cy) * sc),
  st: 'ok', gns: n.node_id,
}));
const out = { layers: { [key]: { label: 'GNS3: LEAF (spine-leaf)', vb: '0 0 900 400', areas: [], nodes, links: [] } } };
fs.writeFileSync('gns3-leaf-import.json', JSON.stringify(out, null, 1));
console.log('nodes:', nodes.map(n => n.label + ' @' + n.x + ',' + n.y + ' [' + n.sub + ']').join(' | '));

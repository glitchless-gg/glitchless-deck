// Finding Decks. With Developer Mode on, a Deck announces its devkit service over mDNS (Bonjour, Avahi)
// as _steamos-devkit._tcp.local, with its login name in the TXT record. This asks on every network
// interface from a port of its own, so the Deck answers straight back (RFC 6762 §6.7), and also listens
// on 5353 where that's allowed. Plain dgram: no Bonjour library and no dns-sd, so it works the same on
// macOS, Windows and Linux.

import dgram from 'node:dgram';
import os from 'node:os';

export const SERVICE = '_steamos-devkit._tcp.local';
const GROUP = '224.0.0.251';
const MDNS_PORT = 5353;
export const TYPE = { A: 1, PTR: 12, TXT: 16, AAAA: 28, SRV: 33 };

function encodeName(name) {
  const parts = [];
  for (const label of name.replace(/\.$/, '').split('.')) {
    const b = Buffer.from(label, 'utf8');
    parts.push(Buffer.from([b.length]), b);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function header(id, flags, qd, an, ar = 0) {
  const h = Buffer.alloc(12);
  h.writeUInt16BE(id, 0);
  h.writeUInt16BE(flags, 2);
  h.writeUInt16BE(qd, 4);
  h.writeUInt16BE(an, 6);
  h.writeUInt16BE(ar, 10);
  return h;
}

/** A query for each { name, type }, asking for a unicast answer. */
export function encodeQuery(questions, id = 0) {
  const parts = [header(id, 0, questions.length, 0)];
  for (const q of questions) {
    const tail = Buffer.alloc(4);
    tail.writeUInt16BE(q.type, 0);
    tail.writeUInt16BE(0x8001, 2); // class IN, unicast response wanted
    parts.push(encodeName(q.name), tail);
  }
  return Buffer.concat(parts);
}

/** An answer (what a Deck sends back); the tests' pretend Deck uses it. */
export function encodeResponse(records, id = 0) {
  const parts = [header(id, 0x8400, 0, records.length)];
  for (const r of records) {
    let data;
    if (r.type === TYPE.A) data = Buffer.from(r.data.split('.').map(Number));
    else if (r.type === TYPE.PTR) data = encodeName(r.data);
    else if (r.type === TYPE.SRV) {
      const fixed = Buffer.alloc(6);
      fixed.writeUInt16BE(r.data.priority || 0, 0);
      fixed.writeUInt16BE(r.data.weight || 0, 2);
      fixed.writeUInt16BE(r.data.port, 4);
      data = Buffer.concat([fixed, encodeName(r.data.target)]);
    } else if (r.type === TYPE.TXT) {
      data = Buffer.concat(Object.entries(r.data).flatMap(([k, v]) => {
        const s = Buffer.from(`${k}=${v}`, 'utf8');
        return [Buffer.from([s.length]), s];
      }));
    } else data = Buffer.alloc(0);
    const fixed = Buffer.alloc(10);
    fixed.writeUInt16BE(r.type, 0);
    fixed.writeUInt16BE(1, 2);
    fixed.writeUInt32BE(r.ttl ?? 120, 4);
    fixed.writeUInt16BE(data.length, 8);
    parts.push(encodeName(r.name), fixed, data);
  }
  return Buffer.concat(parts);
}

function readName(buf, offset) {
  const labels = [];
  let end = null;
  for (let jumps = 0; jumps < 32; ) {
    if (offset >= buf.length) throw new Error('name runs past the packet');
    const len = buf[offset];
    if (len === 0) {
      offset += 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (end == null) end = offset + 2;
      offset = ((len & 0x3f) << 8) | buf[offset + 1];
      jumps++;
      continue;
    }
    labels.push(buf.toString('utf8', offset + 1, offset + 1 + len));
    offset += 1 + len;
  }
  return [labels.join('.'), end ?? offset];
}

export function decodeMessage(buf) {
  const count = (i) => buf.readUInt16BE(i);
  const msg = { id: count(0), flags: count(2), questions: [], records: [] };
  let off = 12;
  for (let i = 0; i < count(4); i++) {
    const [name, next] = readName(buf, off);
    msg.questions.push({ name, type: buf.readUInt16BE(next) });
    off = next + 4;
  }
  const total = count(6) + count(8) + count(10);
  for (let i = 0; i < total; i++) {
    const [name, next] = readName(buf, off);
    const type = buf.readUInt16BE(next);
    const len = buf.readUInt16BE(next + 8);
    const start = next + 10;
    let data = null;
    if (type === TYPE.A && len === 4) data = [...buf.subarray(start, start + 4)].join('.');
    else if (type === TYPE.PTR) data = readName(buf, start)[0];
    else if (type === TYPE.SRV) data = { priority: buf.readUInt16BE(start), weight: buf.readUInt16BE(start + 2), port: buf.readUInt16BE(start + 4), target: readName(buf, start + 6)[0] };
    else if (type === TYPE.TXT) {
      data = {};
      for (let p = start; p < start + len; ) {
        const l = buf[p];
        const s = buf.toString('utf8', p + 1, p + 1 + l);
        const eq = s.indexOf('=');
        if (s) data[eq < 0 ? s : s.slice(0, eq)] = eq < 0 ? '' : s.slice(eq + 1);
        p += 1 + l;
      }
    }
    msg.records.push({ name, type, ttl: buf.readUInt32BE(next + 4), data });
    off = start + len;
  }
  return msg;
}

/** The IPv4 addresses of this computer's network interfaces (not loopback). */
export function localAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push(a);
  }
  return out;
}

/**
 * Decks in Developer Mode on this network: [{ name, host, address, port, login }].
 * GLITCHLESS_DECK_MDNS=host:port sends the question there instead of to the multicast group (tests).
 */
export async function findDecks({ timeout = 2500, target = process.env.GLITCHLESS_DECK_MDNS, service = SERVICE } = {}) {
  const lower = (s) => s.toLowerCase();
  const instances = new Map(); // instance name → { from }
  const srv = new Map();
  const txt = new Map();
  const hosts = new Map();
  const sockets = [];
  const take = (buf, rinfo) => {
    let msg;
    try {
      msg = decodeMessage(buf);
    } catch {
      return;
    }
    if (!(msg.flags & 0x8000)) return; // a question, not an answer
    for (const r of msg.records) {
      const name = lower(r.name);
      if (r.type === TYPE.PTR && name === service) instances.set(r.data, { from: rinfo.address });
      else if (r.type === TYPE.SRV && name.endsWith(`.${service}`)) {
        srv.set(lower(r.name), r.data);
        if (![...instances.keys()].some((k) => lower(k) === name)) instances.set(r.name, { from: rinfo.address });
      } else if (r.type === TYPE.TXT && name.endsWith(`.${service}`)) txt.set(name, r.data);
      else if (r.type === TYPE.A) hosts.set(name, r.data);
    }
  };
  const send = (questions) => {
    const packet = encodeQuery(questions);
    for (const s of sockets) {
      const [host, port] = target ? [target.split(':')[0], Number(target.split(':')[1])] : [GROUP, MDNS_PORT];
      s.send(packet, port, host, () => {});
    }
  };
  const open = (bindAddress, iface) =>
    new Promise((resolve) => {
      const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      s.on('error', () => resolve(null));
      s.on('message', take);
      s.bind({ port: 0, address: bindAddress }, () => {
        try {
          if (iface) s.setMulticastInterface(iface);
          s.setMulticastTTL(255);
        } catch {}
        sockets.push(s);
        resolve(s);
      });
    });

  if (target) await open('127.0.0.1');
  else {
    const ifaces = localAddresses();
    for (const a of ifaces) await open(undefined, a.address);
    if (!ifaces.length) await open();
    // Also listen where multicast answers go, when the system lets two programs share 5353.
    await new Promise((resolve) => {
      const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      s.on('error', () => (s.close(), resolve()));
      s.on('message', take);
      s.bind(MDNS_PORT, () => {
        try {
          for (const a of ifaces) s.addMembership(GROUP, a.address);
          sockets.push({ send: () => {}, close: () => s.close() });
        } catch {
          s.close();
        }
        resolve();
      });
    });
  }

  send([{ name: service, type: TYPE.PTR }]);
  await new Promise((r) => setTimeout(r, Math.min(800, timeout / 2)));
  send([{ name: service, type: TYPE.PTR }]);
  // Ask for what the first answers left out: where each Deck is, and its login.
  const missing = [];
  for (const name of instances.keys()) {
    const s = srv.get(lower(name));
    if (!s) missing.push({ name, type: TYPE.SRV }, { name, type: TYPE.TXT });
    else if (!hosts.has(lower(s.target))) missing.push({ name: s.target, type: TYPE.A });
  }
  if (missing.length) send(missing);
  await new Promise((r) => setTimeout(r, Math.max(300, timeout - 800)));
  for (const s of sockets) s.close();

  const found = [];
  for (const [full, { from }] of instances) {
    const s = srv.get(lower(full));
    const t = txt.get(lower(full)) || {};
    const name = full.slice(0, full.length - service.length - 1);
    const host = s?.target?.replace(/\.$/, '') || '';
    const address = hosts.get(lower(host)) || from;
    if (!found.some((d) => d.address === address)) found.push({ name, host, address, port: s?.port || 32000, login: t.login || null, txtvers: t.txtvers || null });
  }
  return found;
}

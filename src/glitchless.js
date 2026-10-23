// Glitchless on the Deck: a game started with --glitchless --glitchless-intake=http://<this computer>:7777
// reports to the Glitchless server running here. That only works when the server answers on the local
// network (not just on localhost) and nothing in between blocks the Deck, so both are checked first.

import net from 'node:net';
import { localAddresses } from './mdns.js';
import { helper } from './ssh.js';
import { Problem } from './util.js';

const toInt = (ip) => ip.split('.').reduce((n, p) => (n << 8) + Number(p), 0) >>> 0;

/** This computer's address on the Deck's network: same subnet first, then any private IPv4 address. */
export function lanAddressFor(deckAddress, addresses = localAddresses()) {
  if (net.isIPv4(deckAddress)) {
    const same = addresses.find((a) => a.netmask && (toInt(a.address) & toInt(a.netmask)) === (toInt(deckAddress) & toInt(a.netmask)));
    if (same) return same.address;
  }
  const lan = addresses.find((a) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) || addresses[0];
  return lan?.address || null;
}

async function health(url) {
  try {
    const r = await fetch(`${url}/v1/health`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * The flags that point a build on the Deck at a Glitchless server. With no intake given, it is the
 * server on this computer (port 7777, or GLITCHLESS_URL's port), at this computer's LAN address.
 */
export async function intakeFlags(deck, { intake, log = () => {} } = {}) {
  let url = intake;
  if (!url) {
    const port = Number(process.env.GLITCHLESS_URL ? new URL(process.env.GLITCHLESS_URL).port || 80 : 7777);
    if (!(await health(`http://127.0.0.1:${port}`))) {
      throw new Problem(`No Glitchless server answers on this computer at port ${port}. Start it (npm run server in the Glitchless repo), or give --glitchless-intake=URL.`);
    }
    const lan = lanAddressFor(deck.address);
    if (!lan) throw new Problem('This computer has no network address the Deck could reach.');
    url = `http://${lan}:${port}`;
    if (!(await health(url))) {
      throw new Problem(`The Glitchless server answers on localhost but not at ${url}, so the Deck could not reach it. Start it so it listens on every address (npm run server does), not 127.0.0.1 only.`);
    }
  }
  url = url.replace(/\/$/, '');
  const fromDeck = await helper(deck, { do: 'http_check', url: `${url}/v1/health` });
  if (!fromDeck.ok) {
    throw new Problem(`The Deck cannot reach the Glitchless server at ${url} (${fromDeck.error || 'no answer'}). Allow incoming connections to it: on macOS, System Settings > Network > Firewall > Options; on Windows, allow Node.js on private networks.`);
  }
  log(`Glitchless: the game will report to ${url}.`);
  return { url, flags: ['--glitchless', `--glitchless-intake=${url}`] };
}

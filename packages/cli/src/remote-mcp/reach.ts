/**
 * Where a session's node may connect (`network.reach`). A grant's invites
 * and the spaces it syncs name the always-on nodes and relays they meet at,
 * and anyone can make an account and write a grant, so the service follows
 * only those on the public internet: never one that resolves to this
 * machine, its network, or the cloud's metadata address. Its operator's own
 * (`MINCA_NODES`, `MINCA_RELAYS`) are taken as given.
 *
 * Checked when a session starts, by name: a name that resolves elsewhere
 * when the socket opens (DNS rebinding) is not caught.
 */
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

/** Addresses that aren't the public internet's */
const NOT_PUBLIC = (() => {
  const list = new BlockList();
  for (const [net, prefix] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 3],
  ] as const)
    list.addSubnet(net, prefix, 'ipv4');
  for (const [net, prefix] of [
    ['::', 127],
    ['64:ff9b::', 96],
    ['64:ff9b:1::', 48],
    ['100::', 64],
    ['2001:db8::', 32],
    ['fc00::', 7],
    ['fe80::', 10],
    ['fec0::', 10],
    ['ff00::', 8],
  ] as const)
    list.addSubnet(net, prefix, 'ipv6');
  return list;
})();

/** Whether an address is on the public internet; one mapped from IPv4 by the IPv4 it carries */
function publicAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped) return publicAddress(mapped);
  const family = isIP(address);
  if (family === 0) return false;
  return !NOT_PUBLIC.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/** Whether an address (a node, a relay, a host) is over TLS, and every address its name resolves to is public */
export async function publicNode(node: string): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(node);
  } catch {
    return false;
  }
  if (url.protocol !== 'wss:' && url.protocol !== 'https:') return false;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return publicAddress(host);
  const found = await lookup(host, { all: true }).catch(() => []);
  return found.length > 0 && found.every(({ address }) => publicAddress(address));
}

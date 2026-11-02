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
import { Resolver } from 'node:dns/promises';
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

/** The IPv4 address an IPv6 one carries: mapped (`::ffff:`), or translated by DNS64 (`64:ff9b::/96`) */
function carried(address: string): string | null {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped) return mapped;
  const translated = /^64:ff9b::(.+)$/i.exec(address)?.[1];
  if (!translated) return null;
  if (isIP(translated) === 4) return translated;
  const [high = '', low = ''] = translated.includes(':') ? translated.split(':') : ['0', translated];
  const word = (parseInt(high, 16) << 16) | parseInt(low, 16);
  return [24, 16, 8, 0].map((shift) => (word >>> shift) & 255).join('.');
}

/** Whether an address is on the public internet; one carrying IPv4 by the IPv4 it carries */
function publicAddress(address: string): boolean {
  const inner = carried(address);
  if (inner) return publicAddress(inner);
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
  const found = await resolved(host);
  return found.length > 0 && found.every(publicAddress);
}

/** Looked up off the thread pool everything else uses, briefly, a few at a time: a stranger's names can't stall the service */
const resolver = new Resolver({ timeout: 2000, tries: 1 });
const AT_ONCE = 8;
let looking = 0;
const queue: Array<() => void> = [];

async function resolved(host: string): Promise<ReadonlyArray<string>> {
  if (looking >= AT_ONCE) await new Promise<void>((resolve) => queue.push(resolve));
  looking += 1;
  try {
    const [v4, v6] = await Promise.all([
      resolver.resolve4(host).catch(() => []),
      resolver.resolve6(host).catch(() => []),
    ]);
    return [...v4, ...v6];
  } finally {
    looking -= 1;
    queue.shift()?.();
  }
}

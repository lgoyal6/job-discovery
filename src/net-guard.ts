import { lookup as systemLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { Agent } from 'undici';

/**
 * Where an outbound request is allowed to land.
 *
 * Every apply URL this pipeline fetches was written by somebody else: the
 * community lists are public READMEs anyone can open a pull request against,
 * intern-list is scraped markup, and Apify returns whatever its actor found.
 * A row whose link reads http://169.254.169.254/latest/meta-data/ is a request
 * to the host's credential endpoint, made by us, from inside our network, and
 * the answer was landing in the digest: measured before this existed, a
 * loopback service returning a fake AccessKeyId came back as httpOk with the
 * key in the posting summary.
 *
 * Two checks, because neither covers the other:
 *
 *   - The URL check catches a literal address. It has to, because net.connect
 *     skips DNS entirely for one, so no lookup hook ever sees 127.0.0.1.
 *   - The lookup check catches a name. It has to, because nothing about the
 *     string "careers.example.com" says where it resolves, and it can resolve
 *     somewhere different tomorrow.
 *
 * Both run again on every redirect hop, which is why redirects are followed
 * here rather than by fetch: a link that starts on a public board and 302s to
 * the metadata service reaches it otherwise, and that was also measured.
 */

export class BlockedDestinationError extends Error {}
export class ResponseTooLargeError extends Error {}

// IANA special-purpose ranges, which is the whole set that is either ours, the
// network's, or nobody's. A job board is never on one.
const BLOCKED = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]
] as const) BLOCKED.addSubnet(network, prefix, 'ipv4');
// BlockList already reads an IPv4-mapped address (::ffff:127.0.0.1) against the
// rules above. 64:ff9b::/96 and 2002::/16 are the two forms it does not: both
// carry a v4 address inside a v6 one, so ::1 policy alone leaves them open.
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96], ['2002::', 16]
] as const) BLOCKED.addSubnet(network, prefix, 'ipv6');

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  return family !== 0 && BLOCKED.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

/** Throws unless this is an http(s) URL whose literal host, if it has one, is public. */
export function assertAllowedUrl(input: string | URL): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new BlockedDestinationError(`not a URL: ${String(input)}`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedDestinationError(`${url.protocol}// is not a fetchable scheme`);
  }
  // URL keeps the brackets on an IPv6 host; isIP does not want them.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isBlockedAddress(host)) throw new BlockedDestinationError(`${host} is not a public address`);
  return url;
}

/**
 * The connection boundary. net.connect calls this with the name it is about to
 * dial, after the resolver has answered and before a socket exists, so a record
 * that points at a private address fails here whatever the URL said.
 */
export function guardedLookup(
  hostname: string,
  options: { all?: boolean; family?: number; hints?: number },
  callback: (error: NodeJS.ErrnoException | null, address: LookupAddress[] | string, family?: number) => void
): void {
  systemLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) { callback(error, ''); return; }
    const blocked = addresses.find(entry => isBlockedAddress(entry.address));
    if (blocked) {
      callback(new BlockedDestinationError(`${hostname} resolves to ${blocked.address}, which is not a public address`), '');
      return;
    }
    const first = addresses[0];
    if (!first) { callback(new BlockedDestinationError(`${hostname} resolves to nothing`), ''); return; }
    if (options.all) callback(null, addresses);
    else callback(null, first.address, first.family);
  });
}

const guardedDispatcher = new Agent({ connect: { lookup: guardedLookup as never } });

// Node's own redirect handling drops authorization and cookie when the host
// changes but keeps everything else: measured, a request carrying
// authorization, cookie and x-api-key across a cross-origin redirect arrived
// with x-api-key intact. Following redirects here means that stripping is ours
// to do, so it covers anything shaped like a secret rather than the two names
// the spec happens to list.
const CREDENTIAL_HEADERS = /^(authorization|cookie|proxy-authorization)$|key|token|secret|password/i;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 10;

function nextHopInit(init: RequestInit, status: number, crossOrigin: boolean): RequestInit {
  const next = { ...init };
  const method = (typeof init.method === 'string' ? init.method : 'GET').toUpperCase();
  // 303 always becomes a GET; 301 and 302 do so for anything that had a body.
  if ((status === 303 || status === 301 || status === 302) && method !== 'GET' && method !== 'HEAD') {
    next.method = 'GET';
    delete next.body;
  }
  if (crossOrigin && init.headers) {
    const headers = new Headers(init.headers);
    for (const name of [...headers.keys()]) if (CREDENTIAL_HEADERS.test(name)) headers.delete(name);
    next.headers = headers;
  }
  return next;
}

/**
 * fetch, with the destination checked on the way in and on every hop.
 *
 * Redirects are followed here rather than by fetch because fetch would only
 * consult the lookup hook, and a hop to a literal address never reaches one.
 * Headers are left exactly as given on the first hop so that a caller passing
 * none still sends none.
 */
export async function guardedFetch(input: string, init: RequestInit = {}): Promise<Response> {
  let target = assertAllowedUrl(input);
  // The URL the caller wrote, not the one URL round-trips it to: parsing adds a
  // trailing slash to a bare origin and reorders nothing else, but a source
  // that signs or logs its own request URL should see what it asked for.
  let href = input;
  let hopInit: RequestInit = { ...init, redirect: 'manual', dispatcher: guardedDispatcher } as RequestInit;
  for (let hop = 0; ; hop += 1) {
    const response = await fetch(href, hopInit);
    const location = REDIRECT_STATUSES.has(response.status) ? response.headers.get('location') : null;
    if (!location) return response;
    if (hop >= MAX_REDIRECTS) throw new Error(`more than ${MAX_REDIRECTS} redirects from ${input}`);
    let next: URL;
    try { next = new URL(location, target); } catch { return response; }
    const allowed = assertAllowedUrl(next);
    await response.body?.cancel();
    hopInit = nextHopInit(hopInit, response.status, allowed.origin !== target.origin);
    target = allowed;
    href = allowed.href;
  }
}

/**
 * Reads a body, giving up past a byte budget.
 *
 * The budget is spent on decoded bytes, because that is the number that can be
 * chosen by the far end: measured, 30,605 bytes of gzip on the wire expand to
 * 31,457,280 characters, with no content-length header to have caught it. Six
 * postings fetched at once is six of those.
 */
export async function readCappedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let read = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    read += value.byteLength;
    if (read > maxBytes) {
      await reader.cancel();
      throw new ResponseTooLargeError(`response body exceeded ${maxBytes} bytes`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

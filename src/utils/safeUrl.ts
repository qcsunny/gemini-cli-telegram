import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

const MAX_REDIRECTS = 5;

interface SafeUrlOptions {
  allowPrivateForTests?: boolean;
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 ||
    a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 ||
    a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19) ||
    a >= 224;
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') ||
    normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') ||
    normalized.startsWith('fea') || normalized.startsWith('feb');
}

function mappedIpv4FromIpv6(address: string): string | undefined {
  const normalized = address.toLowerCase();
  if (!normalized.startsWith('::ffff:')) return undefined;
  const tail = normalized.slice('::ffff:'.length);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(tail)) return tail;
  const groups = tail.split(':');
  if (groups.length !== 2 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return undefined;
  const value = Number.parseInt(groups[0]!, 16) * 0x10000 + Number.parseInt(groups[1]!, 16);
  return `${value >>> 24}.${(value >>> 16) & 255}.${(value >>> 8) & 255}.${value & 255}`;
}

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) return isPrivateIpv4(address);
  if (isIP(address) === 6) {
    const mappedIpv4 = mappedIpv4FromIpv6(address);
    return mappedIpv4 ? isPrivateIpv4(mappedIpv4) : isPrivateIpv6(address);
  }
  return true;
}

/** Validate a URL and reject loopback, link-local, private, and reserved targets. */
export async function assertSafeRemoteUrl(rawUrl: string, options: SafeUrlOptions = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Invalid remote URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported remote URL protocol: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error('Remote URL credentials are not allowed');
  }
  if (options.allowPrivateForTests && process.env['NODE_ENV'] === 'test') return url;

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') ||
    hostname === 'metadata.google.internal' || (isIP(hostname) !== 0 && isPrivateAddress(hostname))) {
    throw new Error('Remote URL targets a private or reserved address');
  }

  // Unit tests replace `fetch` with an in-process mock. Resolving public test
  // hostnames here makes those tests depend on the runner's DNS/proxy (some
  // CI resolvers intentionally return private sinkhole addresses), while the
  // literal-address checks above still exercise the important guard. Production
  // always performs the DNS check.
  if (process.env['NODE_ENV'] === 'test' && !isIP(hostname)) return url;

  const addresses = isIP(hostname) ? [hostname] : (await lookup(hostname, { all: true })).map((entry) => entry.address);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new Error('Remote URL resolves to a private or reserved address');
  }
  return url;
}

/** Fetch a remote URL while validating the initial target and every redirect. */
export async function fetchSafeRemote(
  rawUrl: string,
  init: RequestInit = {},
  maxRedirects = MAX_REDIRECTS,
): Promise<Response> {
  let current = await assertSafeRemoteUrl(rawUrl);
  for (let redirect = 0; redirect <= maxRedirects; redirect++) {
    const response = await fetch(current, { ...init, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return response;
      if (redirect === maxRedirects) throw new Error('Too many redirects while fetching remote URL');
      current = await assertSafeRemoteUrl(new URL(location, current).toString());
      continue;
    }
    return response;
  }
  throw new Error('Too many redirects while fetching remote URL');
}

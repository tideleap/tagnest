/**
 * SSRF host guard for server-side fetches of user-supplied URLs.
 *
 * Design note — why literal-host classification instead of resolve-then-check:
 * the original audit suggested validating the *resolved* IP addresses (DNS
 * results) rather than the literal host. Cloudflare Workers cannot do that:
 * `fetch` never exposes the IPs it connected to, and the runtime has no DNS
 * resolution API. The substitute is a strict literal-host classifier that
 * fails CLOSED (unparseable IP literal → blocked) and covers the ranges the
 * old regex missed: IPv6 ULA (fc00::/7), link-local (fe80::/10), multicast
 * (ff00::/8), unspecified/loopback, NAT64, documentation and discard prefixes,
 * plus IPv4-mapped IPv6 (::ffff:a.b.c.d) judged by their embedded IPv4.
 *
 * Decimal / octal / hex IPv4 spellings (http://2130706433/, http://0x7f.1/)
 * do NOT need special handling here: WHATWG URL parsing — which every caller
 * runs via `parseUrl` before this guard — normalises them to plain dotted
 * quads (→ `127.0.0.1`), which the IPv4 ranges below then catch.
 */

/**
 * Returns true when the hostname must not be fetched. Accepts the URL
 * `hostname` form (IPv6 literals keep their brackets).
 */
export function isBlockedHost(rawHostname: string): boolean {
  const host = rawHostname.trim().toLowerCase().replace(/\.$/, '');
  if (!host) return true;

  // Names that resolve to loopback by convention (foo.localhost → 127.0.0.1).
  if (host === 'localhost' || host.endsWith('.localhost')) return true;

  // Bracketed IPv6 literal (the URL hostname form).
  if (host.startsWith('[') && host.endsWith(']')) {
    return isBlockedIpv6(host.slice(1, -1));
  }
  // A bare colon still means an IPv6 literal slipped through unbracketed.
  if (host.includes(':')) return isBlockedIpv6(host);

  // Dotted-quad IPv4 literal.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return isBlockedIpv4(host);

  // Ordinary domain name.
  return false;
}

/** Private / reserved / special-use IPv4 ranges. */
function isBlockedIpv4(host: string): boolean {
  const parts = host.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // fail closed
  const [a, b, c] = parts;

  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 0) return true; // 192.0.0/24 special-use + 192.0.2/24 TEST-NET-1
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast 224/4, reserved 240/4, broadcast
  return false;
}

/**
 * Expands an IPv6 address (with optional embedded dotted quad) to its eight
 * hextets, or null when the literal is malformed. Zone ids are rejected.
 */
function expandIpv6(addr: string): number[] | null {
  if (addr.includes('%')) return null;

  // Fold an embedded dotted quad (::ffff:192.168.1.1) into two hextets.
  let s = addr;
  const v4Tail = s.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4Tail) {
    const octets = v4Tail[2].split('.').map((p) => Number.parseInt(p, 10));
    if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    s = `${v4Tail[1]}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }

  const parseGroups = (groups: string[]): number[] | null => {
    const out: number[] = [];
    for (const g of groups) {
      if (g === '' || !/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(Number.parseInt(g, 16));
    }
    return out;
  };

  const halves = s.split('::');
  if (halves.length > 2) return null;

  if (halves.length === 2) {
    const head = halves[0] === '' ? [] : parseGroups(halves[0].split(':'));
    const tail = halves[1] === '' ? [] : parseGroups(halves[1].split(':'));
    if (!head || !tail || head.length + tail.length > 7) return null;
    return [...head, ...Array(8 - head.length - tail.length).fill(0), ...tail];
  }

  const groups = parseGroups(s.split(':'));
  return groups && groups.length === 8 ? groups : null;
}

/** Private / reserved / special-use IPv6 prefixes. */
function isBlockedIpv6(addr: string): boolean {
  const h = expandIpv6(addr);
  if (!h) return true; // unparseable literal → fail closed

  if (h.every((n) => n === 0)) return true; // :: unspecified
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0 && h[6] === 0 && h[7] === 1) {
    return true; // ::1 loopback
  }
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0xffff) {
    // ::ffff:0:0/96 IPv4-mapped — judge by the embedded IPv4 address.
    return isBlockedIpv4(`${h[6] >> 8}.${h[6] & 0xff}.${h[7] >> 8}.${h[7] & 0xff}`);
  }
  if ((h[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((h[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((h[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (h[0] === 0x2001 && h[1] === 0xdb8) return true; // 2001:db8::/32 documentation
  if (h[0] === 0x64 && h[1] === 0xff9b) return true; // 64:ff9b::/96 NAT64 (and /48 variant)
  if (h[0] === 0x100 && h[1] === 0 && h[2] === 0 && h[3] === 0) return true; // 100::/64 discard
  return false;
}

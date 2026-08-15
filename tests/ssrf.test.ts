import { describe, expect, it } from 'vitest';
import { isBlockedHost } from '../functions/_lib/ssrf';

describe('isBlockedHost — IPv4', () => {
  it('blocks loopback, RFC1918, link-local and this-network', () => {
    expect(isBlockedHost('127.0.0.1')).toBe(true);
    expect(isBlockedHost('127.5.6.7')).toBe(true);
    expect(isBlockedHost('10.0.0.1')).toBe(true);
    expect(isBlockedHost('192.168.1.1')).toBe(true);
    expect(isBlockedHost('172.16.0.1')).toBe(true);
    expect(isBlockedHost('172.31.255.255')).toBe(true);
    expect(isBlockedHost('169.254.169.254')).toBe(true); // cloud metadata
    expect(isBlockedHost('0.0.0.0')).toBe(true);
  });

  it('blocks CGNAT, TEST-NETs, benchmarking, multicast and reserved', () => {
    expect(isBlockedHost('100.64.0.1')).toBe(true);
    expect(isBlockedHost('100.127.255.255')).toBe(true);
    expect(isBlockedHost('192.0.2.1')).toBe(true);
    expect(isBlockedHost('198.51.100.1')).toBe(true);
    expect(isBlockedHost('203.0.113.1')).toBe(true);
    expect(isBlockedHost('198.18.0.1')).toBe(true);
    expect(isBlockedHost('224.0.0.1')).toBe(true);
    expect(isBlockedHost('255.255.255.255')).toBe(true);
  });

  it('allows public IPv4', () => {
    expect(isBlockedHost('8.8.8.8')).toBe(false);
    expect(isBlockedHost('1.1.1.1')).toBe(false);
    expect(isBlockedHost('172.15.0.1')).toBe(false); // just below RFC1918
    expect(isBlockedHost('172.32.0.1')).toBe(false); // just above RFC1918
    expect(isBlockedHost('100.63.255.255')).toBe(false); // just below CGNAT
    expect(isBlockedHost('100.128.0.0')).toBe(false); // just above CGNAT
  });

  it('fails closed on malformed dotted quads', () => {
    expect(isBlockedHost('999.1.1.1')).toBe(true);
    expect(isBlockedHost('1.2.3')).toBe(false); // not a quad → treated as a domain name
  });
});

describe('isBlockedHost — names', () => {
  it('blocks localhost and subdomains', () => {
    expect(isBlockedHost('localhost')).toBe(true);
    expect(isBlockedHost('foo.localhost')).toBe(true);
    expect(isBlockedHost('LOCALHOST')).toBe(true);
  });

  it('allows ordinary domains', () => {
    expect(isBlockedHost('example.com')).toBe(false);
    expect(isBlockedHost('notlocalhost.com')).toBe(false);
    expect(isBlockedHost('github.com')).toBe(false);
  });
});

describe('isBlockedHost — IPv6', () => {
  it('blocks loopback, unspecified, ULA, link-local and multicast', () => {
    expect(isBlockedHost('[::1]')).toBe(true);
    expect(isBlockedHost('[::]')).toBe(true);
    expect(isBlockedHost('[fd12:3456::1]')).toBe(true); // ULA
    expect(isBlockedHost('[fc00::1]')).toBe(true); // ULA boundary
    expect(isBlockedHost('[fe80::1]')).toBe(true); // link-local
    expect(isBlockedHost('[ff02::1]')).toBe(true); // multicast
    expect(isBlockedHost('[2001:db8::1]')).toBe(true); // documentation
    expect(isBlockedHost('[64:ff9b::1]')).toBe(true); // NAT64
    expect(isBlockedHost('[100::1]')).toBe(true); // discard-only
  });

  it('blocks IPv4-mapped IPv6 by the embedded IPv4', () => {
    expect(isBlockedHost('[::ffff:127.0.0.1]')).toBe(true);
    expect(isBlockedHost('[::ffff:7f00:1]')).toBe(true); // hex form of 127.0.0.1
    expect(isBlockedHost('[::ffff:192.168.0.1]')).toBe(true);
    expect(isBlockedHost('[::ffff:8.8.8.8]')).toBe(false);
  });

  it('allows public IPv6', () => {
    expect(isBlockedHost('[2606:4700:4700::1111]')).toBe(false); // Cloudflare DNS
    expect(isBlockedHost('[2001:4860:4860::8888]')).toBe(false); // Google DNS
  });

  it('fails closed on malformed literals', () => {
    expect(isBlockedHost('[zzzz::1]')).toBe(true);
    expect(isBlockedHost('[1:2:3:4:5:6:7:8:9]')).toBe(true);
    expect(isBlockedHost('[fe80::1%eth0]')).toBe(true); // zone id rejected
    expect(isBlockedHost('[1::2::3]')).toBe(true);
  });
});

describe('isBlockedHost — URL-normalised encoding variants', () => {
  // WHATWG URL parsing (run by parseUrl before this guard) already folds
  // decimal/octal/hex IPv4 spellings into dotted quads; these assertions pin
  // the end-to-end behaviour using the URL hostname as input.
  it('catches decimal/octal/hex IPv4 after URL normalisation', () => {
    expect(isBlockedHost(new URL('http://2130706433/').hostname)).toBe(true);
    expect(isBlockedHost(new URL('http://0x7f.0.0.1/').hostname)).toBe(true);
    expect(isBlockedHost(new URL('http://0177.0.0.1/').hostname)).toBe(true);
  });
});

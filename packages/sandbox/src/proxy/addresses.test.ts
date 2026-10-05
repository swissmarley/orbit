import { describe, expect, it } from 'vitest';
import {
  addressAllowed,
  blockedAddressReason,
  canonicalAddress,
  nameAllowed,
  normalizeHostName,
  parseAllowlist,
} from './addresses';

describe('blockedAddressReason', () => {
  const cases: [string, string | null][] = [
    // public
    ['93.184.215.14', null],
    ['1.1.1.1', null],
    ['2606:4700:4700::1111', null],
    ['2a00:1450:4001:80b::200e', null],
    // IPv4 special-purpose
    ['0.0.0.0', 'unspecified'],
    ['10.1.2.3', 'private'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['100.100.100.200', 'carrier-grade NAT'], // Alibaba metadata
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['169.254.169.254', 'link-local'], // AWS/GCP/Azure metadata
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['198.18.0.1', 'benchmarking'],
    ['224.0.0.251', 'multicast'],
    ['239.255.255.250', 'multicast'],
    ['255.255.255.255', 'reserved'],
    // IPv6 special-purpose
    ['::', 'unspecified'],
    ['::1', 'loopback'],
    ['fe80::1', 'link-local'],
    ['fc00::1', 'unique-local'],
    ['fd00:ec2::254', 'unique-local'], // AWS IPv6 metadata
    ['ff02::1', 'multicast'],
    ['fec0::1', 'site-local'],
    // IPv4 carried in IPv6
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:7f00:1', 'loopback'],
    ['::ffff:169.254.169.254', 'link-local'],
    ['::ffff:93.184.215.14', null],
    ['64:ff9b::a00:1', 'private'],
    ['64:ff9b::5db8:d70e', null],
    ['2002:c0a8:0101::1', 'private'],
    ['::10.0.0.1', 'IPv4-compatible'],
    // not an address
    ['example.com', 'not an IP address'],
    ['', 'not an IP address'],
  ];
  for (const [address, reason] of cases) {
    it(`${address || '(empty)'} → ${reason ?? 'public'}`, () => {
      expect(blockedAddressReason(address)).toBe(reason);
    });
  }
});

describe('allowlist parsing and matching', () => {
  it('parses names, wildcards, IP literals and ports; invalid entries never match', () => {
    const list = parseAllowlist([
      'PyPI.org',
      '*.github.com',
      'files.pythonhosted.org.',
      'registry.npmjs.org:8443',
      '10.0.0.5',
      '[fd00::1]:9000',
      '2001:db8::1',
      'not a host',
      '*',
      '*.com.',
      'localhost',
      'example.com:99999',
      '1.2.3',
    ]);
    expect(list.rules).toEqual([
      { kind: 'host', host: 'pypi.org', port: 443 },
      { kind: 'suffix', suffix: 'github.com', port: 443 },
      { kind: 'host', host: 'files.pythonhosted.org', port: 443 },
      { kind: 'host', host: 'registry.npmjs.org', port: 8443 },
      { kind: 'address', address: '10.0.0.5', port: 443 },
      { kind: 'address', address: canonicalAddress('fd00::1'), port: 9000 },
      { kind: 'address', address: canonicalAddress('2001:db8::1'), port: 443 },
    ]);
    expect(list.invalid).toEqual([
      'not a host',
      '*',
      '*.com.',
      'localhost',
      'example.com:99999',
      '1.2.3',
    ]);
  });

  it('matches exact names and *. suffixes on the allowed port only', () => {
    const { rules } = parseAllowlist(['pypi.org', '*.github.com', 'npm.example.org:8443']);
    const table: [string, number, boolean][] = [
      ['pypi.org', 443, true],
      ['pypi.org', 80, false],
      ['www.pypi.org', 443, false],
      ['evilpypi.org', 443, false],
      ['pypi.org.evil.com', 443, false],
      ['api.github.com', 443, true],
      ['a.b.github.com', 443, true],
      ['github.com', 443, false], // a wildcard is subdomains only
      ['evilgithub.com', 443, false],
      ['npm.example.org', 8443, true],
      ['npm.example.org', 443, false],
    ];
    for (const [host, port, allowed] of table) {
      expect(nameAllowed(rules, normalizeHostName(host)!, port), `${host}:${port}`).toBe(allowed);
    }
  });

  it('matches literal addresses in any IPv6 spelling', () => {
    const { rules } = parseAllowlist(['[fd00::1]:9000', '10.0.0.5']);
    expect(addressAllowed(rules, 'fd00:0:0:0:0:0:0:1', 9000)).toBe(true);
    expect(addressAllowed(rules, 'FD00::1', 9000)).toBe(true);
    expect(addressAllowed(rules, 'fd00::1', 443)).toBe(false);
    expect(addressAllowed(rules, '10.0.0.5', 443)).toBe(true);
    expect(addressAllowed(rules, '10.0.0.6', 443)).toBe(false);
  });

  it('normalizes host names and refuses what is not one', () => {
    expect(normalizeHostName('Example.COM.')).toBe('example.com');
    expect(normalizeHostName('xn--bcher-kva.example')).toBe('xn--bcher-kva.example');
    for (const bad of [
      '',
      'localhost',
      '-a.com',
      'a-.com',
      'a..com',
      'a_b.com',
      '1.2.3.4',
      'a'.repeat(64) + '.com',
    ]) {
      expect(normalizeHostName(bad), bad).toBeNull();
    }
  });
});

import { describe, expect, it } from 'vitest';
import {
  type AddressKind,
  addressKind,
  addressRefusal,
  allowsPrivate,
  canonicalAddress,
  parseIpv6,
} from './address';

describe('addressKind', () => {
  it.each<[string, AddressKind]>([
    // IPv4
    ['8.8.8.8', 'public'],
    ['93.184.216.34', 'public'],
    ['1.1.1.1', 'public'],
    ['0.0.0.0', 'unspecified'],
    ['0.1.2.3', 'unspecified'],
    ['10.0.0.1', 'private'],
    ['10.255.255.255', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['172.32.0.1', 'public'],
    ['192.168.1.1', 'private'],
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['169.254.1.1', 'link-local'],
    ['169.254.169.254', 'metadata'],
    ['100.64.0.1', 'cgnat'],
    ['100.127.255.255', 'cgnat'],
    ['100.128.0.1', 'public'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.250', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'reserved'],
    ['192.0.2.1', 'reserved'],
    ['198.51.100.7', 'reserved'],
    ['203.0.113.9', 'reserved'],
    ['198.18.0.1', 'reserved'],
    ['192.0.0.8', 'reserved'],
    // IPv6
    ['2606:4700:4700::1111', 'public'],
    ['2a00:1450:4001:82a::200e', 'public'],
    ['::', 'unspecified'],
    ['::1', 'loopback'],
    ['fc00::1', 'unique-local'],
    ['fd12:3456::1', 'unique-local'],
    ['fd00:ec2::254', 'metadata'],
    ['fe80::1', 'link-local'],
    ['febf::1', 'link-local'],
    ['fec0::1', 'private'],
    ['ff02::1', 'multicast'],
    ['2001:db8::1', 'reserved'],
    ['100::1', 'reserved'],
    ['2001::1', 'reserved'],
    ['::ffff:0:0:1', 'reserved'],
    // IPv4 inside IPv6: judged by the IPv4 address
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:7f00:1', 'loopback'],
    ['::ffff:10.1.2.3', 'private'],
    ['::ffff:169.254.169.254', 'metadata'],
    ['::ffff:8.8.8.8', 'public'],
    ['::127.0.0.1', 'loopback'],
    ['64:ff9b::7f00:1', 'loopback'],
    ['64:ff9b::a9fe:a9fe', 'metadata'],
    ['64:ff9b::808:808', 'public'],
    ['64:ff9b:1::1', 'private'],
    ['2002:7f00:1::1', 'loopback'],
    ['2002:c0a8:101::1', 'private'],
    ['2002:808:808::1', 'public'],
    // Not an address at all
    ['example.com', 'reserved'],
    ['fe80::1%eth0', 'reserved'],
    ['1.2.3', 'reserved'],
  ])('%s is %s', (address, kind) => {
    expect(addressKind(address)).toBe(kind);
  });
});

describe('parseIpv6 and canonicalAddress', () => {
  it('expands :: and embedded IPv4', () => {
    expect(parseIpv6('::1')).toEqual([...Array<number>(15).fill(0), 1]);
    expect(parseIpv6('[::ffff:1.2.3.4]')?.slice(10)).toEqual([0xff, 0xff, 1, 2, 3, 4]);
    expect(parseIpv6('1:2:3:4:5:6:7:8')?.slice(14)).toEqual([0, 8]);
    expect(parseIpv6('1::2::3')).toBeNull();
    expect(parseIpv6('12345::')).toBeNull();
  });

  it('writes addresses the way the allowlist stores IP literals', () => {
    expect(canonicalAddress('::ffff:127.0.0.1')).toBe('[::ffff:7f00:1]');
    expect(canonicalAddress('[::1]')).toBe('[::1]');
    expect(canonicalAddress('127.0.0.1')).toBe('127.0.0.1');
    expect(canonicalAddress('localhost')).toBeNull();
  });
});

describe('addressRefusal', () => {
  const strict = { listed: new Set<string>(), allowPrivate: false };

  it('allows public addresses (positive control)', () => {
    expect(addressRefusal('93.184.216.34', strict)).toBeNull();
    expect(addressRefusal('2606:4700:4700::1111', strict)).toBeNull();
  });

  it('refuses everything else by default, saying what it is', () => {
    expect(addressRefusal('10.0.0.5', strict)).toBe('10.0.0.5 is a private address');
    expect(addressRefusal('127.0.0.1', strict)).toBe('127.0.0.1 is a loopback address');
    expect(addressRefusal('::ffff:127.0.0.1', strict)).toBe(
      '[::ffff:7f00:1] is a loopback address',
    );
    expect(addressRefusal('169.254.169.254', strict)).toBe(
      '169.254.169.254 is a cloud metadata address',
    );
    expect(addressRefusal('fd00:ec2::254', strict)).toBe(
      '[fd00:ec2::254] is a cloud metadata address',
    );
    expect(addressRefusal('100.64.1.1', strict)).toBe('100.64.1.1 is a carrier-grade NAT address');
    expect(addressRefusal('nonsense', strict)).toBe('nonsense is not an IP address');
  });

  it('allows an address the owner listed exactly, in any spelling', () => {
    const listed = { listed: new Set(['127.0.0.1', '[::1]']), allowPrivate: false };
    expect(addressRefusal('127.0.0.1', listed)).toBeNull();
    expect(addressRefusal('::1', listed)).toBeNull();
    expect(addressRefusal('0:0:0:0:0:0:0:1', listed)).toBeNull();
    expect(addressRefusal('127.0.0.2', listed)).not.toBeNull();
  });

  it('with private addresses allowed: intranets yes; metadata, unspecified, multicast and reserved never', () => {
    const intranet = { listed: new Set<string>(), allowPrivate: true };
    for (const a of ['10.1.2.3', '192.168.0.10', '127.0.0.1', 'fd12::1', 'fe80::1', '100.64.0.9']) {
      expect(addressRefusal(a, intranet), a).toBeNull();
    }
    for (const a of [
      '169.254.169.254',
      'fd00:ec2::254',
      '0.0.0.0',
      '::',
      '224.0.0.1',
      '240.0.0.1',
    ]) {
      expect(addressRefusal(a, intranet), a).not.toBeNull();
    }
    // Unless the owner listed that exact address.
    expect(
      addressRefusal('169.254.169.254', {
        listed: new Set(['169.254.169.254']),
        allowPrivate: false,
      }),
    ).toBeNull();
  });

  it('turns private addresses on only for an explicit yes', () => {
    expect(allowsPrivate('true')).toBe(true);
    expect(allowsPrivate(' YES ')).toBe(true);
    expect(allowsPrivate('1')).toBe(true);
    for (const v of [undefined, '', 'false', '0', 'no', 'maybe'])
      expect(allowsPrivate(v)).toBe(false);
  });
});

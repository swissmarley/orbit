import { ToolError } from '@orbit/plugin-kit';
import { describe, expect, it } from 'vitest';
import {
  canonicalHost,
  checkPageUrl,
  hostAllowed,
  parseAllowlist,
  requestVerdict,
} from './allowlist';

const allow = parseAllowlist(
  'Example.com, *.wikipedia.org., docs.example.net, 127.0.0.1, [::1], bücher.de',
);
const ok = (url: string) => requestVerdict(allow, url).allowed;

describe('allowlist parsing', () => {
  it('canonicalises entries: case, trailing dot, IDN to punycode, IPv6 brackets', () => {
    expect([...allow.exact].sort()).toEqual(
      ['127.0.0.1', '[::1]', 'docs.example.net', 'example.com', 'xn--bcher-kva.de'].sort(),
    );
    expect(allow.suffixes).toEqual(['.wikipedia.org']);
    expect(canonicalHost('::1')).toBe('[::1]');
    expect(canonicalHost('127.1')).toBe('127.0.0.1');
    expect(canonicalHost('EXAMPLE.com.')).toBe('example.com');
  });

  it('refuses entries that are not host names, never ignoring them silently', () => {
    for (const bad of [
      'https://example.com',
      'example.com/path',
      'example.com:8080',
      'user@example.com',
      '*',
      '*.com',
      'foo.*.com',
      '*example.com',
      '*.127.0.0.1',
      'example..com',
      '.example.com',
    ]) {
      expect(() => parseAllowlist(`ok.example, ${bad}`), bad).toThrow(ToolError);
    }
    expect(() => parseAllowlist(' , ,')).toThrow(/no domains/);
  });
});

describe('host matching', () => {
  it('matches exact hosts only, ignoring case, a trailing dot and the port', () => {
    expect(hostAllowed(allow, 'example.com')).toBe(true);
    expect(hostAllowed(allow, 'EXAMPLE.COM')).toBe(true);
    expect(hostAllowed(allow, 'example.com.')).toBe(true);
    expect(hostAllowed(allow, 'www.example.com')).toBe(false);
    expect(hostAllowed(allow, 'notexample.com')).toBe(false);
    expect(hostAllowed(allow, 'example.com.evil.org')).toBe(false);
    expect(hostAllowed(allow, 'example.com..')).toBe(false);
    expect(ok('https://example.com:8443/x')).toBe(true);
    expect(ok('http://Example.COM./')).toBe(true);
    expect(ok('https://example.net/')).toBe(false);
  });

  it('*.domain allows subdomains at any depth but not the domain itself', () => {
    expect(ok('https://en.wikipedia.org/wiki/Orbit')).toBe(true);
    expect(ok('https://a.b.wikipedia.org/')).toBe(true);
    expect(ok('https://wikipedia.org/')).toBe(false);
    expect(ok('https://evilwikipedia.org/')).toBe(false);
    expect(ok('https://wikipedia.org.evil.com/')).toBe(false);
  });

  it('compares IDN hosts in punycode', () => {
    expect(ok('https://bücher.de/')).toBe(true);
    expect(ok('https://BÜCHER.de/')).toBe(true);
    expect(ok('https://xn--bcher-kva.de/')).toBe(true);
    expect(ok('https://bucher.de/')).toBe(false);
    // A look-alike (Cyrillic 'е') is a different host.
    expect(ok('https://еxample.com/')).toBe(false);
  });

  it('allows IP literals only when listed exactly, in any spelling the URL parser normalises', () => {
    expect(ok('http://127.0.0.1:4000/')).toBe(true);
    expect(ok('http://127.1/')).toBe(true);
    expect(ok('http://0x7f.0.0.1/')).toBe(true);
    expect(ok('http://[::1]:8080/')).toBe(true);
    expect(ok('http://127.0.0.2/')).toBe(false);
    expect(ok('http://[::2]/')).toBe(false);
    expect(ok('http://2130706434/')).toBe(false); // 127.0.0.2 as one number
    const wild = parseAllowlist('*.example.com');
    expect(hostAllowed(wild, '10.0.0.1')).toBe(false);
  });
});

describe('request and page URL checks', () => {
  it('lets the page fetch only http(s)/ws(s) on allowed hosts, plus in-browser data: and blob:', () => {
    expect(ok('wss://example.com/socket')).toBe(true);
    expect(ok('ws://evil.org/socket')).toBe(false);
    expect(ok('data:text/plain,hi')).toBe(true);
    expect(ok('blob:https://example.com/0a1b')).toBe(true);
    for (const url of [
      'file:///etc/passwd',
      'ftp://example.com/',
      'chrome://settings',
      'javascript:alert(1)',
      'about:config',
      'not a url',
    ]) {
      expect(ok(url), url).toBe(false);
    }
    expect(requestVerdict(allow, 'https://evil.org/x')).toEqual({
      allowed: false,
      host: 'evil.org',
    });
  });

  it('refuses credentials in a URL, also on an allowed host', () => {
    expect(ok('https://user:pw@example.com/')).toBe(false);
    expect(ok('https://user@example.com/')).toBe(false);
    expect(() => checkPageUrl(allow, 'https://user:pw@example.com/')).toThrow(/password/);
  });

  it('opens only http and https pages on allowed hosts', () => {
    expect(checkPageUrl(allow, ' https://en.wikipedia.org/wiki/Moon ').href).toBe(
      'https://en.wikipedia.org/wiki/Moon',
    );
    for (const url of [
      'file:///etc/passwd',
      'data:text/html,<h1>x</h1>',
      'javascript:alert(1)',
      'chrome://version',
      'about:blank',
      'view-source:https://example.com/',
      'ws://example.com/',
    ]) {
      expect(() => checkPageUrl(allow, url), url).toThrow(/Only http and https/);
    }
    expect(() => checkPageUrl(allow, 'https://evil.org/')).toThrow(
      /evil\.org is not in the domains/,
    );
    expect(() => checkPageUrl(allow, 'example.com')).toThrow(/Not a valid URL/);
  });
});

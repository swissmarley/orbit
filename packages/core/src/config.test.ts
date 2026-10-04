import { describe, expect, it } from 'vitest';
import { OrbitConfig, humanPrincipalCount, isLoopbackHost } from './config';

describe('OrbitConfig', () => {
  it('applies safe local defaults', () => {
    const c = OrbitConfig.parse({ home: '/tmp/orbit' });
    expect(c.mode).toBe('local');
    expect(c.api).toEqual({ host: '127.0.0.1', port: 7420 });
    expect(c.driver).toBeNull();
    expect(c.models).toEqual({ default: 'opus', triage: 'haiku' });
    expect(c.sdk.bare).toBe(true);
    expect(c.limits.maxConcurrentRuns.cli).toBe(2);
    expect(humanPrincipalCount(c)).toBe(1);
  });

  it('rejects an empty principal list', () => {
    expect(() => OrbitConfig.parse({ home: '/x', principals: [] })).toThrow();
  });
});

describe('isLoopbackHost', () => {
  it.each(['127.0.0.1', '127.1.2.3', 'localhost', '::1', '[::1]', '::ffff:127.0.0.1'])(
    '%s is loopback',
    (h) => expect(isLoopbackHost(h)).toBe(true),
  );
  it.each(['0.0.0.0', '::', '192.168.1.10', '10.0.0.1', 'orbit.example.com', '128.0.0.1'])(
    '%s is not loopback',
    (h) => expect(isLoopbackHost(h)).toBe(false),
  );
});

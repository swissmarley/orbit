import type { EngineKeyProxy } from '../src/drivers/sdk';

/**
 * A stand-in for orbitd's HostKeyProxy (whose own tests are in
 * @orbit/sandbox): hands out a lease per segment and records whether it ended.
 */
export class FakeKeyProxy implements EngineKeyProxy {
  readonly leases: { token: string; baseUrl: string; closed: boolean }[] = [];

  open(): Promise<{ baseUrl: string; token: string; close(): void }> {
    const token = `segment-token-${this.leases.length}-0123456789abcdefghijklmn`;
    const lease = { token, baseUrl: `http://127.0.0.1:9/${token}`, closed: false };
    this.leases.push(lease);
    return Promise.resolve({
      baseUrl: lease.baseUrl,
      token,
      close: () => {
        lease.closed = true;
      },
    });
  }
}

/** @jsxRuntime automatic @jsxImportSource react */
import { OidcSignIn } from '@orbit/api';
import { harness } from '@orbit/api/testing';
import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { type Mounted, mountApp } from '../test/harness';

/** Hosted mode in the App (ADR-015): OIDC sign-in and who is signed in. */

const PUBLIC = 'https://orbit.example.com';

function hosted() {
  const config = {
    mode: 'hosted' as const,
    principals: [{ id: 'ada', kind: 'human' as const, name: 'Ada', oidc: { subject: 'sub-ada' } }],
    hosted: { publicUrl: PUBLIC, oidc: { issuer: 'https://id.example.com', clientId: 'orbit' } },
  };
  // Never contacted here: the issuer is reached only when someone follows the link.
  const oidc = new OidcSignIn({
    issuer: 'https://id.example.com',
    clientId: 'orbit',
    clientSecret: () => null,
    scopes: ['openid'],
    redirectUri: `${PUBLIC}/v1/auth/oidc/callback`,
    principals: () => [],
  });
  return harness({ config, app: { hosted: { publicUrl: PUBLIC, oidc, tls: false } } });
}

let m: Mounted | undefined;
afterEach(async () => {
  m?.unmount();
  await m?.h.close();
  m = undefined;
});

describe('hosted sign-in', () => {
  it('signed out, the App offers the identity provider instead of `orbit app`', async () => {
    m = mountApp('/inbox', { h: hosted(), token: 'not-the-token' });
    const link = await screen.findByRole('link', { name: 'Sign in' });
    expect(link.getAttribute('href')).toBe('/v1/auth/oidc/login');
    expect(screen.queryByText('orbit app')).toBeNull();
  });

  it('signed in, the sidebar names the principal and its role, with Sign out', async () => {
    m = mountApp('/inbox', { h: hosted() });
    const who = await screen.findByTestId('signed-in-as');
    expect(who.textContent).toBe('Server operator · owner');
    const sidebar = who.closest('aside');
    expect(sidebar).not.toBeNull();
    expect(within(sidebar!).getByRole('button', { name: 'Sign out Server operator' })).toBeTruthy();
  });

  it('local mode keeps the one-time link from `orbit app`', async () => {
    m = mountApp('/inbox', { token: 'not-the-token' });
    expect(await screen.findByText('orbit app')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Sign in' })).toBeNull();
  });
});

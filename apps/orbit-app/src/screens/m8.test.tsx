/** @jsxRuntime automatic @jsxImportSource react */
import { harness } from '@orbit/api/testing';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Mounted, mountApp } from '../test/harness';

let m: Mounted | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  m?.unmount();
  await m?.h.close();
  m = undefined;
});

/** Capture what the App hands to the browser as a download. */
function captureDownloads(): { name: string; blob: Blob }[] {
  const saved: { name: string; blob: Blob }[] = [];
  const blobs = new Map<string, Blob>();
  vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => {
    const url = `blob:test/${blobs.size}`;
    blobs.set(url, b as Blob);
    return url;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    const blob = blobs.get(this.href);
    if (blob) saved.push({ name: this.download, blob });
  });
  return saved;
}

describe('Settings → Audit (keyed chain, M8)', () => {
  it('says since when the chain is keyed, downloads a checkpoint and verifies against it', async () => {
    const h = harness();
    await h.json('POST', '/v1/bots', { name: 'Notes', goal: 'g' });
    const saved = captureDownloads();
    m = mountApp('/settings?tab=audit', { h });
    const user = userEvent.setup();
    expect((await screen.findByTestId('audit-keying')).textContent).toMatch(
      /Keyed since .* \(record #1\)/,
    );

    await user.click(screen.getByRole('button', { name: /Download checkpoint/ }));
    expect(await screen.findByText(/Checkpoint at record #2 downloaded/)).toBeTruthy();
    expect(saved).toHaveLength(1);
    expect(saved[0]!.name).toMatch(/^orbit-audit-checkpoint-\d{4}-\d{2}-\d{2}-2\.json$/);
    const text = await saved[0]!.blob.text();
    expect(JSON.parse(text)).toMatchObject({ kind: 'orbit-audit-checkpoint', seq: 2 });

    const input = screen.getByLabelText<HTMLInputElement>('Checkpoint file to verify');
    await user.upload(input, new File([text], 'cp.json', { type: 'application/json' }));
    expect(
      await screen.findByText(/still contains this checkpoint, signed by this audit key/),
    ).toBeTruthy();

    const edited = JSON.stringify({ ...JSON.parse(text), count: 99 });
    await user.upload(input, new File([edited], 'cp.json', { type: 'application/json' }));
    expect(
      await screen.findByText(/Checkpoint check failed: the checkpoint is not signed/),
    ).toBeTruthy();

    await user.upload(input, new File(['nope'], 'bad.json', { type: 'application/json' }));
    expect(await screen.findByText(/bad\.json is not a checkpoint file/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /Verify the hash chain/ }));
    await waitFor(() =>
      expect(screen.getByText(/Chain intact: \d+ records verified/)).toBeTruthy(),
    );
  });

  it('counts the records from before the audit key existed', async () => {
    const h = harness({ start: false });
    h.service.audit.append({ actor: 'owner', action: 'bot.created' });
    h.db.sqlite.exec('DROP TRIGGER audit_no_update');
    h.db.sqlite.exec('UPDATE audit SET mac = NULL');
    h.service.audit.ensureKeyed();
    h.service.start();
    m = mountApp('/settings?tab=audit', { h });
    expect((await screen.findByTestId('audit-keying')).textContent).toMatch(
      /Keyed since .* \(record #2\) · 1 older record from before the audit key existed \(up to #1\)/,
    );
  });
});

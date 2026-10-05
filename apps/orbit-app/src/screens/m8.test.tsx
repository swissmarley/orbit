/** @jsxRuntime automatic @jsxImportSource react */
import { harness } from '@orbit/api/testing';
import { screen, waitFor, within } from '@testing-library/react';
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

describe('Memory → Export / Import (M8)', () => {
  const line = (over: Record<string, unknown>) =>
    JSON.stringify({
      kind: 'fact',
      source: 'owner',
      title: 'Owner fact',
      body: 'Grace signs off.',
      createdAt: '2026-01-01T00:00:00.000Z',
      ...over,
    });
  const header = JSON.stringify({
    kind: 'orbit-memory-export',
    v: 1,
    exportedAt: 'x',
    bots: [],
    count: 2,
  });

  it('exports the filtered Bot and previews an import before writing it', async () => {
    const h = harness();
    await h.json('POST', '/v1/bots', { name: 'Notes', goal: 'g' });
    const copy = (await h.json<{ id: string }>('POST', '/v1/bots', { name: 'Copy', goal: 'g' }))
      .body;
    await h.json('POST', '/v1/bots/notes/memory', { title: 'Launch owner', body: 'Ada.' });
    const saved = captureDownloads();
    m = mountApp(`/memory?bot=${copy.id}`, { h });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Export this Bot/ }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]!.name).toMatch(/^orbit-memory-copy-.*\.jsonl$/);

    await user.click(screen.getByRole('button', { name: /Import…/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Import memories' });
    const jsonl = [
      header,
      line({}),
      line({ source: 'bot', kind: 'note', taint: ['WebFetch'] }),
    ].join('\n');
    await user.upload(
      within(dialog).getByLabelText('Export file (.jsonl)'),
      new File([jsonl], 'notes.jsonl', { type: 'application/x-ndjson' }),
    );
    const preview = await within(dialog).findByTestId('import-preview');
    expect(preview.textContent).toMatch(/2 memories:.*1 trusted,.*1 untrusted/);
    expect(preview.textContent).toMatch(/says it was written by you/);
    expect(h.service.memory.count(copy.id)).toBe(0);

    await user.click(within(dialog).getByRole('checkbox', { name: /Mark everything untrusted/ }));
    await waitFor(() =>
      expect(within(dialog).getByTestId('import-preview').textContent).toMatch(
        /0 trusted,.*2 untrusted \(all marked untrusted\)/,
      ),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Import 2 memories' }));
    await waitFor(() => expect(h.service.memory.count(copy.id)).toBe(2));
    const stored = h.service.memory.list({ botId: copy.id });
    expect(stored.every((x) => x.taint.includes('import'))).toBe(true);
  });

  it('shows why a file cannot be imported and does not offer to import it', async () => {
    const h = harness();
    await h.json('POST', '/v1/bots', { name: 'Notes', goal: 'g' });
    m = mountApp('/memory', { h });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Import…/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Import memories' });
    await user.upload(
      within(dialog).getByLabelText('Export file (.jsonl)'),
      new File([[header, '{nope'].join('\n')], 'bad.jsonl'),
    );
    expect(await within(dialog).findByText(/line 2: not JSON/)).toBeTruthy();
    const button = within(dialog).getByRole('button', { name: 'Import' });
    expect(button.hasAttribute('disabled')).toBe(true);
  });
});

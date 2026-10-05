/** @jsxRuntime automatic @jsxImportSource react */
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { KeyRound, Terminal } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { authStore, csrfSecret, errorText, takeTicketFromLocation, useClient } from '../lib/api';
import { keys } from '../lib/queries';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';

/** Not signed in: how to get in (the token never enters the browser, ADR-011). */
export function SignedOut({ error }: { error?: unknown }) {
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardContent className="flex flex-col gap-4 pt-6">
          <div className="flex items-center gap-2">
            <KeyRound className="size-5 text-accent" aria-hidden />
            <h1 className="text-lg font-semibold">Sign in to Orbit</h1>
          </div>
          {error ? (
            <p role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">
              {errorText(error)}
            </p>
          ) : null}
          <p className="text-sm text-fg-muted">
            Orbit runs on this computer. Open the App from a terminal — it signs this browser in
            with a one-time link:
          </p>
          <pre className="flex items-center gap-2 rounded-md bg-surface-2 px-3 py-2 font-mono text-sm">
            <Terminal className="size-4 text-fg-muted" aria-hidden />
            orbit app
          </pre>
          <p className="text-xs text-fg-subtle">
            Each link works once, within 2 minutes. Restarting orbitd signs every browser out. Your
            API token never enters the browser.
          </p>
          <Button variant="secondary" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

/** /login#ticket=…: trade the one-time ticket for the session cookie, then go home. */
export function LoginScreen() {
  const client = useClient();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [error, setError] = useState<unknown>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const ticket = takeTicketFromLocation(window.location, window.history);
    void (async () => {
      try {
        if (ticket) {
          const { csrf } = await client.call('createSession', { body: { ticket } });
          csrfSecret.set(csrf);
        } else await client.call('getSession');
        authStore.set('signed-in');
        await qc.invalidateQueries({ queryKey: keys.all });
        await navigate({ to: '/', replace: true });
      } catch (err) {
        authStore.set('signed-out');
        setError(err);
      }
    })();
  }, [client, qc, navigate]);

  if (error) return <SignedOut error={error} />;
  return (
    <div className="flex min-h-full items-center justify-center p-6" role="status">
      <p className="text-sm text-fg-muted">Signing you in…</p>
    </div>
  );
}

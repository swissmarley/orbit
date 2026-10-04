export function readFixture(path: string): Record<string, unknown>[];
export function replay(
  messages: Record<string, unknown>[],
  options: {
    decide: (hookInput: Record<string, unknown>) => Promise<unknown>;
    sessionId: string | undefined | null;
    cwd: string;
  },
): AsyncGenerator<Record<string, unknown>>;

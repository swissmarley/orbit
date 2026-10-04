import { MockDriver } from '../src/drivers/mock';
import { type Harness, runDriverContract } from './driver-contract';

runDriverContract('MockDriver', (): Harness => ({
  prepare(scenario) {
    if (scenario === 'hang') {
      return Promise.resolve({
        driver: new MockDriver({ delayMs: 60_000 }),
        base: { mockFixture: 'subagent-delegation' },
      });
    }
    return Promise.resolve({ driver: new MockDriver(), base: { mockFixture: scenario } });
  },
  cleanup: () => Promise.resolve(),
}));

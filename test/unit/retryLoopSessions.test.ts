/**
 * Regression for 1.6.0: the multi-bridge CCU retry loop opened one CCU
 * JSON-API session per attempt and never closed it, until the CCU refused
 * every login ("invalid credentials or too many sessions"). Real CcuClient
 * and MultiBridgeHost against a fake CCU that keeps real sessions.
 */

import { describe, it, expect, vi } from 'vitest';
import type { HAP } from 'homebridge';
import { CcuClient } from '../../src/ccu/CcuClient.js';
import { MultiBridgeHost } from '../../src/multiBridge/MultiBridgeHost.js';
import { resolveConfig } from '../../src/util/config.js';
import type { MultiBridgeConfig, MultiBridgeEntry } from '../../src/types.js';
import { cleanup, fakeCcu, prefixed, recordingLog, sharedSession } from './gas/helpers.js';

cleanup();

describe('multi-bridge CCU retry loop leaves no CCU session open', () => {
  it('every failed attempt logs its session out, with backoff between attempts', async () => {
    {
      const fake = await fakeCcu();
      const log = recordingLog();
      const config = resolveConfig({
        platform: 'HomematicHap',
        ccuIp: '127.0.0.1',
        eventServer: { host: '127.0.0.1', port: 9876 },
        interfaces: { bidcosRf: false, hmIpRf: false, bidcosWired: false, virtualDevices: false, cuxd: false },
      });
      const ccu = new CcuClient({ config, log: prefixed(log) });
      // Point the JSON-API at the fake CCU (CcuClient always uses port 80/443).
      Object.defineProperty(ccu, 'api', { value: sharedSession(fake.port, log) });
      vi.spyOn(ccu.eventServer, 'start').mockResolvedValue(undefined);
      vi.spyOn(ccu.eventServer, 'stop').mockResolvedValue(undefined);
      const multi: MultiBridgeConfig = {
        advertiser: 'ciao',
        // Not reachable through config validation (min 5 s); keeps the test fast.
        retrySeconds: 0.01,
        bridges: [{ name: 'HomeMatic Test', enabled: true, variables: [] } as unknown as MultiBridgeEntry],
      };
      const host = new MultiBridgeHost({
        hap: {} as HAP,
        ccu,
        config: multi,
        log: prefixed(log),
        version: '0.0.0',
        identityStore: { check: () => ({ accessoryInfo: 'ok', identifierCache: 'ok' }) },
      });
      const started = host.start();
      const attempts = (): string[] => log.lines.filter((l) => /CCU not ready/.test(l));
      await vi.waitFor(() => expect(attempts().length).toBeGreaterThanOrEqual(5), { timeout: 5000, interval: 5 });
      await host.stop();
      await started;
      const n = attempts().length;
      expect(attempts().map((l) => l.match(/retrying in ([\d.]+) s/)?.[1]).slice(0, 4)).toEqual(['0.01', '0.02', '0.04', '0.08']);
      expect(fake.created).toBeGreaterThanOrEqual(n);
      expect(fake.logouts).toBe(fake.created);
      expect(fake.sessions.size).toBe(0);
    }
  });
});

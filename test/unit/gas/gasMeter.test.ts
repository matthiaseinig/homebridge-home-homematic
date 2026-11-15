import { createServer } from 'node:net';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HAP } from 'homebridge';
import { GAS_SERVICE } from '../../../src/gas/definitions.js';
import { GAS_HISTORY_DIR, GasMeter } from '../../../src/gas/GasMeter.js';
import { GAS_TOKEN_FILE, loadOrCreateToken } from '../../../src/gas/token.js';
import { ADDRESS, cleanup, clock, fakeCcu, gasSettings, HOST, PASSWORD, prefixed, recordingLog, sharedSession, tempDir, USER } from './helpers.js';

const hap = (await import(process.env.HAP_NODEJS_PATH ?? '@homebridge/hap-nodejs')) as unknown as HAP;

cleanup();

const T0 = Date.UTC(2026, 10, 15, 9, 0, 0);

async function meter(api: { bindAddress: string; port: number } | undefined) {
  const ccu = await fakeCcu();
  ccu.values = { GAS_ENERGY_COUNTER: '777.000000', GAS_POWER: '0.000000' };
  const root = await tempDir();
  const log = recordingLog();
  const session = sharedSession(ccu.port, log);
  const t = clock(T0);
  const gas = new GasMeter({
    // port 0 (any free port) is not a valid config value, so the API settings are set directly
    settings: api ? { ...gasSettings(), api } : gasSettings(),
    hap,
    session,
    ccu: { host: HOST, username: USER, password: PASSWORD },
    storageRoot: root,
    log: prefixed(log),
    deps: { now: t.now, setTimer: () => 0, clearTimer: () => undefined },
  });
  return { ccu, root, log, session, gas };
}

describe('GasMeter', () => {
  it('serves the API with a token from a 0600 file in the storage folder and never logs it', async () => {
    const { root, log, gas, session } = await meter({ bindAddress: '127.0.0.1', port: 0 });
    await gas.start();
    await gas.service.ready;
    const file = join(root, GAS_TOKEN_FILE);
    const token = (await readFile(file, 'utf8')).trim();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const res = await fetch(`http://127.0.0.1:${gas.apiPort}/v1/gas/status`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect((await res.json()).counterM3).toBe(777);
    const all = log.lines.join('\n');
    expect(all).not.toContain(token);
    expect(all).toContain(GAS_TOKEN_FILE);
    for (const s of [ADDRESS, PASSWORD, USER]) expect(all).not.toContain(s);
    await gas.stop();
    await session.logout();
    // the history and state live in their own folder
    expect((await stat(join(root, GAS_HISTORY_DIR, 'gas-state.json'))).isFile()).toBe(true);
  });

  it('keeps an existing token and replaces a malformed one', async () => {
    const root = await tempDir();
    const file = join(root, GAS_TOKEN_FILE);
    const first = await loadOrCreateToken(file);
    expect(first.created).toBe(true);
    expect(await loadOrCreateToken(file)).toEqual({ token: first.token, created: false });
    await writeFile(file, 'short\n');
    const replaced = await loadOrCreateToken(file);
    expect(replaced.created).toBe(true);
    expect(replaced.token).not.toBe(first.token);
  });

  it('keeps polling when the API port is taken and logs only the error code', async () => {
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    const port = (blocker.address() as { port: number }).port;
    try {
      const { log, gas, session } = await meter({ bindAddress: '127.0.0.1', port });
      await gas.start();
      await gas.service.ready;
      expect(gas.apiPort).toBeUndefined();
      expect(log.lines.some((l) => l.startsWith('error') && l.includes('EADDRINUSE'))).toBe(true);
      expect(log.lines.join('\n')).not.toContain('127.0.0.1');
      expect(gas.service.reading.ccuOk).toBe(true);
      await gas.stop();
      await session.logout();
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });

  it('runs without an API, and a bridged accessory gets the last values at once', async () => {
    const { log, gas, session } = await meter(undefined);
    await gas.start();
    await gas.service.ready;
    expect(log.lines.some((l) => l.includes('LAN API off'))).toBe(true);
    const acc = gas.createBridgedAccessory();
    expect(acc.UUID).toBe(GasMeter.uuid(hap));
    const svc = acc.services.find((s) => s.UUID === GAS_SERVICE.uuid)!;
    expect(svc.characteristics.find((c) => c.UUID.startsWith('F7A000A1'))!.value).toBe(777);
    await gas.stop();
    await session.logout();
  });
});

/**
 * The command line tools for the multi-bridge cutover: the generator
 * (hap-homematic backup -> one multi-bridge block) and the batch
 * enable/disable tool. They run the built plugin (dist/), like on the Mac.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { statSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { create as tarCreate } from 'tar';
import { resolveConfig } from '../../src/util/config.js';
import type { RawConfig } from '../../src/types.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GEN = path.join(root, 'scripts', 'hap-homematic-to-config.mjs');
const ENABLE = path.join(root, 'scripts', 'multi-bridge-enable.mjs');
const IID = path.join(root, 'scripts', 'iid-check.mjs');

const INST_A = '2595a84c-0000-4000-8000-00000000000a';
const INST_B = 'aaaa7332-0000-4000-8000-00000000000b';
const PIN_A = '111-22-333';
const PIN_B = '444-55-666';
const CONFIG = {
  instances: {
    [INST_A]: { name: 'Room_A', user: 'CC:22:3D:E3:CE:0A', pincode: PIN_A, setupID: 'AB12', publishDevices: true },
    [INST_B]: { name: 'Room B', user: 'CC:22:3D:E3:CE:0B', pincode: PIN_B, setupID: 'CD34', publishDevices: true },
    'empty-instance': { name: 'Empty', user: 'CC:22:3D:E3:CE:0E', pincode: '777-88-999', publishDevices: true },
  },
  mappings: {
    '0000AAAAAAAAAA:4': { name: 'Blind A', Service: 'HomeMaticBlindIPAccessory', instance: [INST_A], settings: {} },
    '0000BBBBBBBBBB:3': { name: 'Lamp B', Service: 'HomeMaticSwitchAccessory', instance: [INST_B], settings: { Type: 'Lightbulb' } },
  },
  channels: ['0000AAAAAAAAAA:4', '0000BBBBBBBBBB:3'],
  variables: [],
  programs: [],
};
const DEVICES = {
  devices: [
    { id: 1, name: 'a', address: '0000AAAAAAAAAA', type: 'HmIPW-DRBL4', channels: [{ id: 11, name: 'c', address: '0000AAAAAAAAAA:4', type: 'BLIND_VIRTUAL_RECEIVER' }] },
    { id: 2, name: 'b', address: '0000BBBBBBBBBB', type: 'HmIPW-DRS8', channels: [{ id: 21, name: 'c', address: '0000BBBBBBBBBB:3', type: 'SWITCH_VIRTUAL_RECEIVER' }] },
  ],
};

let dir = '';
let tarball = '';

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hmhap-scripts-'));
  await fs.mkdir(path.join(dir, 'persist'));
  await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(CONFIG));
  await fs.writeFile(path.join(dir, 'devices.json'), JSON.stringify(DEVICES));
  for (const id of ['CC223DE3CE0A', 'CC223DE3CE0B']) {
    await fs.writeFile(path.join(dir, 'persist', `AccessoryInfo.${id}.json`), JSON.stringify({ signSk: 'fake', pincode: 'x' }));
    await fs.writeFile(path.join(dir, 'persist', `IdentifierCache.${id}.json`), JSON.stringify({ cache: {} }));
  }
  tarball = path.join(dir, 'backup.tar.gz');
  await tarCreate({ gzip: true, file: tarball, cwd: dir }, ['./config.json', './devices.json', './persist']);
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const gen = (args: string[]) => spawnSync(process.execPath, [GEN, tarball, '--ccu-ip', '10.0.0.2', ...args], { encoding: 'utf8' });
const enable = (args: string[]) => spawnSync(process.execPath, [ENABLE, ...args], { encoding: 'utf8' });
const readJson = async (f: string) => JSON.parse(await fs.readFile(f, 'utf8'));

describe('hap-homematic-to-config.mjs (multi-bridge layout)', () => {
  it('emits one valid block, every bridge disabled unless --enable, identities preserved', async () => {
    const out = path.join(dir, 'multi.json');
    const persistOut = path.join(dir, 'p-out');
    const r = gen(['--out', out, '--enable', 'Room_A', '--smoke-bridge', '0000AAAAAAAAAA:4', '--persist-out', persistOut, '--persist-bridge', 'Room_A']);
    expect(r.status, r.stderr).toBe(0);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/111-22-333|444-55-666|AB12|CD34/);
    expect(r.stderr).toMatch(/1 multi-bridge block, 3 bridge\(s\), 1 enabled/);
    expect(statSync(out).mode & 0o777).toBe(0o600);

    const blocks = await readJson(out);
    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    expect(block.channels).toBeUndefined();
    expect(block._bridge.username).toMatch(/^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/);
    const bridges = block.multiBridge.bridges;
    expect(bridges.map((b: { name: string; enabled: boolean }) => [b.name, b.enabled])).toEqual([
      ['HomeMatic Room A', true],
      ['HomeMatic Room B', false],
      ['HomeMatic Smoke Test', false],
    ]);
    expect(bridges[0]).toMatchObject({ username: 'CC:22:3D:E3:CE:0A', pincode: PIN_A, setupID: 'AB12', bridgeUuid: INST_A });
    expect(bridges[0].channels[0].uuidSeed).toBe('BLIND_VIRTUAL_RECEIVER:Blind A');
    expect(bridges[2]).toMatchObject({ newIdentity: true, hapHomematicIdentity: false });
    expect(bridges[2].username).not.toMatch(/^CC:22/);

    const resolved = resolveConfig(block as RawConfig);
    expect(resolved.channels.map((c) => c.address)).toEqual(['0000AAAAAAAAAA:4']);

    expect((await fs.readdir(persistOut)).sort()).toEqual(['AccessoryInfo.CC223DE3CE0A.json', 'IdentifierCache.CC223DE3CE0A.json']);
    expect(statSync(path.join(persistOut, 'AccessoryInfo.CC223DE3CE0A.json')).mode & 0o777).toBe(0o600);
  });

  it('still writes the per-bridge layout on request', async () => {
    const r = gen(['--per-bridge-blocks', '--preserve-identity']);
    expect(r.status, r.stderr).toBe(0);
    const blocks = JSON.parse(r.stdout);
    expect(blocks.map((b: { name: string }) => b.name)).toEqual(['HomeMatic Room A', 'HomeMatic Room B']);
    expect(blocks[0]._bridge.username).toBe('CC:22:3D:E3:CE:0A');
  });

  it('rejects unknown names and options that need the multi-bridge layout', () => {
    expect(gen(['--enable', 'Nope']).stderr).toMatch(/--enable: no non-empty hap-homematic bridge named: Nope/);
    expect(gen(['--per-bridge-blocks', '--enable', 'Room_A']).stderr).toMatch(/need the multi-bridge layout/);
    expect(gen(['--frobnicate']).stderr).toMatch(/Unknown option/);
  });
});

describe('hap-homematic-to-config.mjs --new-identities', () => {
  const MAC = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/;
  type Entry = { name: string; username: string; pincode: string; setupID: string; port: number; [k: string]: unknown };

  it('gives every bridge a new, stable identity next to the still-paired hap-homematic bridges', async () => {
    const out1 = path.join(dir, 'new-1.json');
    const out2 = path.join(dir, 'new-2.json');
    const r1 = gen(['--new-identities', '--enable', 'Room_A', '--enable', 'Room B', '--out', out1]);
    expect(r1.status, r1.stderr).toBe(0);
    expect(`${r1.stdout}${r1.stderr}`).not.toMatch(/\d{3}-\d{2}-\d{3}/);
    expect(r1.stderr).toMatch(/1 multi-bridge block, 2 bridge\(s\), 2 enabled, new identities/);
    const block = (await readJson(out1))[0];
    const bridges: Entry[] = block.multiBridge.bridges;
    expect(bridges.map((b) => b.name)).toEqual(['HomeMatic Room A', 'HomeMatic Room B']);
    const oldUsers = Object.values(CONFIG.instances).map((i) => i.user);
    for (const b of bridges) {
      expect(b).toMatchObject({ enabled: true, newIdentity: true, hapHomematicIdentity: false });
      expect(b.bridgeUuid).toBeUndefined();
      expect(b.username).toMatch(MAC);
      expect(oldUsers).not.toContain(b.username);
      expect(b.pincode).toMatch(/^\d{3}-\d{2}-\d{3}$/);
      expect([PIN_A, PIN_B]).not.toContain(b.pincode);
      expect(b.setupID).toMatch(/^[0-9A-Z]{4}$/);
      expect(['AB12', 'CD34']).not.toContain(b.setupID);
      for (const m of [...(b.channels as object[]), ...(b.variables as object[])]) {
        expect(m).not.toHaveProperty('uuidSeed');
      }
    }
    expect(bridges[1].channels).toEqual([
      { address: '0000BBBBBBBBBB:3', name: 'Lamp B', service: 'SwitchAccessory', subtype: 'lightbulb', instance: INST_B, settings: {} },
    ]);
    const resolved = resolveConfig(block as RawConfig);
    expect(resolved.multiBridge?.bridges.every((b) => b.newIdentity && !b.hapHomematicIdentity)).toBe(true);

    // Usernames and ports derive from the instance ids: a fresh run gives the same ones.
    const r2 = gen(['--new-identities', '--out', out2]);
    expect(r2.status, r2.stderr).toBe(0);
    const again: Entry[] = (await readJson(out2))[0].multiBridge.bridges;
    expect(again.map((b) => [b.username, b.port])).toEqual(bridges.map((b) => [b.username, b.port]));
  });

  it('keeps pin, setupID, username and port of bridges already in the --base block', async () => {
    const first = path.join(dir, 'new-base.json');
    expect(gen(['--new-identities', '--out', first]).status).toBe(0);
    const base = (await readJson(first))[0];
    base.multiBridge.bridges[0].enabled = true;
    base._bridge = { name: 'HomeMatic HAP', username: '0E:00:00:00:00:01', port: 36000 };
    const baseFile = path.join(dir, 'new-base-block.json');
    await fs.writeFile(baseFile, JSON.stringify(base));
    const out = path.join(dir, 'new-rerun.json');
    const r = gen(['--new-identities', '--base', baseFile, '--host-bridge-from-base', '--out', out]);
    expect(r.status, r.stderr).toBe(0);
    const block = (await readJson(out))[0];
    const pick = (b: Entry) => [b.name, b.username, b.pincode, b.setupID, b.port];
    expect(block.multiBridge.bridges.map(pick)).toEqual(base.multiBridge.bridges.map(pick));
    expect(block.multiBridge.bridges.map((b: Entry) => b.enabled)).toEqual([true, false]);
    expect(block._bridge).toEqual({ name: 'HomeMatic HAP', username: '0E:00:00:00:00:01', port: 36000 });
  });

  it('refuses combinations that would transplant or need the multi-bridge layout', () => {
    expect(gen(['--new-identities', '--persist-out', path.join(dir, 'x')]).stderr).toMatch(/--persist-out.*--new-identities/);
    expect(gen(['--per-bridge-blocks', '--new-identities']).stderr).toMatch(/need the multi-bridge layout/);
    expect(gen(['--host-bridge-from-base']).stderr).toMatch(/--host-bridge-from-base needs --base/);
  });
});

describe('hap-homematic-to-config.mjs --new-identities hardening', () => {
  type Entry = { name: string; username: string; pincode: string; port: number; enabled: boolean; [k: string]: unknown };
  const importer = path.join(root, 'dist', 'src', 'import', 'HapHomematicImporter.js');
  const identityFor = async (seed: string): Promise<{ username: string; port: number }> =>
    (await import(importer)).bridgeIdentityFor(seed);
  const writeTar = async (name: string, config: object): Promise<string> => {
    const d = path.join(dir, name);
    await fs.mkdir(d);
    await fs.writeFile(path.join(d, 'config.json'), JSON.stringify(config));
    await fs.writeFile(path.join(d, 'devices.json'), JSON.stringify(DEVICES));
    const file = path.join(dir, `${name}.tar.gz`);
    await tarCreate({ gzip: true, file, cwd: d }, ['./config.json', './devices.json']);
    return file;
  };
  const genWith = (tar: string, args: string[]) =>
    spawnSync(process.execPath, [GEN, tar, '--ccu-ip', '10.0.0.2', '--new-identities', ...args], { encoding: 'utf8' });
  const bridgesOf = async (out: string): Promise<Entry[]> => (await readJson(out))[0].multiBridge.bridges;

  it('walks the username-collision loop until the username is free', async () => {
    const a = await identityFor(INST_A);
    const a1 = await identityFor(`${INST_A}:1`);
    const config = {
      ...CONFIG,
      instances: {
        ...CONFIG.instances,
        [INST_A]: { ...CONFIG.instances[INST_A], user: a.username },
        [INST_B]: { ...CONFIG.instances[INST_B], user: a1.username },
      },
    };
    const out = path.join(dir, 'collide.json');
    const r = genWith(await writeTar('collide', config), ['--out', out]);
    expect(r.status, r.stderr).toBe(0);
    const [first] = await bridgesOf(out);
    const a2 = await identityFor(`${INST_A}:2`);
    expect(first!.username).toBe(a2.username);
    expect([a.username, a1.username]).not.toContain(first!.username);
  });

  it('bumps a port that is taken by the event server, and keeps going', async () => {
    const a = await identityFor(INST_A);
    const out = path.join(dir, 'bump.json');
    const r = gen(['--new-identities', '--event-port-base', String(a.port), '--out', out]);
    expect(r.status, r.stderr).toBe(0);
    const [first] = await bridgesOf(out);
    expect(first!.port).toBeGreaterThan(a.port);
    expect(first!.port).not.toBe(a.port);
  });

  it('reserves the ports of kept bridges before assigning new ones, so a kept bridge never moves', async () => {
    const first = path.join(dir, 'kept-1.json');
    expect(gen(['--new-identities', '--out', first]).status).toBe(0);
    const base = (await readJson(first))[0];
    const [keptA, keptB] = base.multiBridge.bridges as Entry[];
    // Only bridge B is in --base, and it sits on the port bridge A would get.
    const aPort = (await identityFor(INST_A)).port;
    keptB!.port = aPort;
    base.multiBridge.bridges = [keptB];
    const baseFile = path.join(dir, 'kept-base.json');
    await fs.writeFile(baseFile, JSON.stringify(base));
    const out = path.join(dir, 'kept-2.json');
    const r = gen(['--new-identities', '--base', baseFile, '--out', out]);
    expect(r.status, r.stderr).toBe(0);
    const [a, b] = await bridgesOf(out);
    expect(b!.port).toBe(aPort);
    expect(b!.username).toBe(keptB!.username);
    expect(a!.port).not.toBe(aPort);
    expect(keptA).toBeDefined();
  });

  it('avoids ports of other child bridges from --reserve-ports and from a full config', async () => {
    const a = await identityFor(INST_A);
    const b = await identityFor(INST_B);
    const out1 = path.join(dir, 'res-1.json');
    const r1 = gen(['--new-identities', '--reserve-ports', `${a.port},${b.port}`, '--out', out1]);
    expect(r1.status, r1.stderr).toBe(0);
    const ports1 = (await bridgesOf(out1)).map((x) => x.port);
    expect(ports1).not.toContain(a.port);
    expect(ports1).not.toContain(b.port);

    const full = {
      bridge: { name: 'Homebridge', port: a.port },
      platforms: [
        { platform: 'HomematicHap', name: 'HomeMatic Bridges', ccuIp: '10.0.0.9', _bridge: { name: 'x', username: '0E:00:00:00:00:01', port: 36001 } },
        { platform: 'Other', name: 'Other', _bridge: { name: 'o', username: '0E:00:00:00:00:02', port: b.port } },
      ],
    };
    const fullFile = path.join(dir, 'full-config.json');
    await fs.writeFile(fullFile, JSON.stringify(full));
    const out2 = path.join(dir, 'res-2.json');
    const r2 = spawnSync(process.execPath, [GEN, tarball, '--new-identities', '--base', fullFile, '--out', out2], { encoding: 'utf8' });
    expect(r2.status, r2.stderr).toBe(0);
    const block = (await readJson(out2))[0];
    expect(block.ccuIp).toBe('10.0.0.9');
    const ports2 = block.multiBridge.bridges.map((x: Entry) => x.port);
    expect(ports2).not.toContain(a.port);
    expect(ports2).not.toContain(b.port);
    expect(gen(['--new-identities', '--reserve-ports', '99999']).stderr).toMatch(/--reserve-ports/);
    expect(gen(['--reserve-ports', '9000']).stderr).toMatch(/need --new-identities/);
  });

  it('warns and disables a bridge whose base identity is discarded, unless --keep-enabled', async () => {
    const first = path.join(dir, 'disc-1.json');
    expect(gen(['--new-identities', '--out', first]).status).toBe(0);
    const base = (await readJson(first))[0];
    const [entA, entB] = base.multiBridge.bridges as Entry[];
    entA!.enabled = true;
    entB!.enabled = true;
    entA!.username = CONFIG.instances[INST_A].user; // an old hap-homematic username
    delete entB!.pincode; // missing pin
    const baseFile = path.join(dir, 'disc-base.json');
    await fs.writeFile(baseFile, JSON.stringify(base));

    const out = path.join(dir, 'disc-2.json');
    const r = gen(['--new-identities', '--base', baseFile, '--out', out]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/bridge "HomeMatic Room A".*discarded.*hap-homematic username.*disabled/);
    expect(r.stderr).toMatch(/bridge "HomeMatic Room B".*discarded.*no pincode/);
    expect(r.stderr).not.toMatch(/\d{3}-\d{2}-\d{3}/);
    const bridges = await bridgesOf(out);
    expect(bridges.map((x) => x.enabled)).toEqual([false, false]);
    expect(bridges[0]!.username).not.toBe(CONFIG.instances[INST_A].user);
    expect(bridges[1]!.pincode).toMatch(/^\d{3}-\d{2}-\d{3}$/);

    const out2 = path.join(dir, 'disc-3.json');
    const r2 = gen(['--new-identities', '--base', baseFile, '--keep-enabled', '--out', out2]);
    expect(r2.status, r2.stderr).toBe(0);
    expect(r2.stderr).toMatch(/discarded/);
    expect((await bridgesOf(out2)).map((x) => x.enabled)).toEqual([true, true]);
  });
});

describe('iid-check.mjs on new identities', () => {
  it('builds new-identity bridges offline and reports their accessories', async () => {
    const out = path.join(dir, 'iid-new.json');
    expect(gen(['--new-identities', '--enable', 'Room_A', '--enable', 'Room B', '--out', out]).status).toBe(0);
    const report = path.join(dir, 'iid-new-report.json');
    const r = spawnSync(process.execPath, [IID, '--config', out, '--persist', path.join(dir, 'empty-persist'),
      '--devices', path.join(dir, 'devices.json'), '--json', report], { encoding: 'utf8' });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/^ok +HomeMatic Room A: 1 acc/m);
    expect(r.stdout).toMatch(/^ok +HomeMatic Room B: 1 acc/m);
    const { totals } = await readJson(report);
    expect(totals).toMatchObject({ bridges: 2, accessories: 2, skippedMappings: 0, mismatches: 0 });
  });
});

describe('multi-bridge-enable.mjs', () => {
  async function homebridgeConfig(): Promise<string> {
    const r = gen([]);
    const file = path.join(dir, `config-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
    const doc = { bridge: { name: 'Homebridge' }, platforms: [{ platform: 'Other' }, ...JSON.parse(r.stdout)] };
    await fs.writeFile(file, JSON.stringify(doc, null, 4), { mode: 0o640 });
    return file;
  }

  it('enables and disables named bridges in a Homebridge config.json, keeping mode and indentation', async () => {
    const file = await homebridgeConfig();
    const r = enable([file, '--bridge', 'HomeMatic Room B']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Enabled: HomeMatic Room B/);
    expect(r.stdout).toMatch(/^enabled +HomeMatic Room B$/m);
    expect(r.stdout).toMatch(/^disabled +HomeMatic Room A$/m);
    expect(r.stdout).not.toMatch(/444-55-666|111-22-333/);
    expect(statSync(file).mode & 0o777).toBe(0o640);
    const text = await fs.readFile(file, 'utf8');
    expect(text).toMatch(/\n {4}"platforms"/);
    const doc = JSON.parse(text);
    expect(doc.platforms[0]).toEqual({ platform: 'Other' });
    expect(doc.platforms[1].multiBridge.bridges[1].enabled).toBe(true);

    expect(enable([file, '--bridge', 'HomeMatic Room B']).stdout).toMatch(/No change/);
    const off = enable([file, '--disable', '--bridge', 'HomeMatic Room B']);
    expect(off.stdout).toMatch(/Disabled: HomeMatic Room B/);
    expect((await readJson(file)).platforms[1].multiBridge.bridges[1].enabled).toBe(false);
  });

  it('dry run, list, unknown names and missing persist files change nothing', async () => {
    const file = await homebridgeConfig();
    const before = await fs.readFile(file, 'utf8');
    expect(enable([file, '--bridge', 'HomeMatic Room A', '--dry-run']).stdout).toMatch(/Would enable: HomeMatic Room A/);
    expect(enable([file, '--list']).stdout).toMatch(/^disabled +HomeMatic Room A$/m);
    const unknown = enable([file, '--bridge', 'Nope']);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toMatch(/Unknown bridge/);
    const lacking = enable([file, '--bridge', 'HomeMatic Room A', '--persist-dir', path.join(dir, 'empty-persist')]);
    expect(lacking.status).toBe(1);
    expect(lacking.stderr).toMatch(/Persist files missing for: HomeMatic Room A/);
    expect(await fs.readFile(file, 'utf8')).toBe(before);
    const ok = enable([file, '--bridge', 'HomeMatic Room A', '--persist-dir', path.join(dir, 'persist')]);
    expect(ok.status, ok.stderr).toBe(0);
  });

  it('needs a multi-bridge block and picks one by --block when there are several', async () => {
    const plain = path.join(dir, 'plain.json');
    await fs.writeFile(plain, JSON.stringify({ platform: 'HomematicHap', name: 'x' }));
    expect(enable([plain, '--list']).stderr).toMatch(/No HomematicHap multi-bridge block/);
    const two = path.join(dir, 'two.json');
    const block = JSON.parse(execFileSync(process.execPath, [GEN, tarball, '--ccu-ip', '10.0.0.2'], { encoding: 'utf8' }))[0];
    await fs.writeFile(two, JSON.stringify([block, { ...block, name: 'Second' }], null, 2));
    expect(enable([two, '--list']).stderr).toMatch(/pick one with --block/);
    expect(enable([two, '--list', '--block', 'Second']).status).toBe(0);
    expect(enable([]).status).toBe(2);
  });
});

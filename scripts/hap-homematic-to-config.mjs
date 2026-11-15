#!/usr/bin/env node
/**
 * Turn a hap-homematic backup (.tar.gz from its Backup menu) into a
 * Homebridge platform block for this plugin, without the config UI.
 *
 *   node scripts/hap-homematic-to-config.mjs <backup.tar.gz> [options]
 *
 * Layouts
 *   (default)                 One block in multi-bridge mode: one Homebridge child
 *                             process, one CCU connection, and one HAP bridge per
 *                             hap-homematic bridge with its original identity
 *                             (username, pin, setupID, bridge UUID, accessory UUIDs).
 *                             Every bridge is listed with enabled=false; enable
 *                             them batch by batch with scripts/multi-bridge-enable.mjs.
 *   --per-bridge-blocks       Old layout: one platform block (child bridge) per
 *                             hap-homematic bridge. Identity only with
 *                             --preserve-identity.
 *
 * Options
 *   --bridge <name>           Only this hap-homematic bridge (instance name, e.g.
 *                             "Keller"); repeatable. Default: all non-empty bridges.
 *   --enable <name>           Multi-bridge: list this bridge as enabled; repeatable.
 *   --name <block name>       Multi-bridge: block name (default "HomeMatic Bridges").
 *   --advertiser <name>       Multi-bridge: ciao (default), bonjour-hap, avahi, resolved.
 *   --smoke-bridge <address>  Multi-bridge: add a throwaway bridge "HomeMatic Smoke Test"
 *                             with a new identity and one read-only accessory for this
 *                             channel (new accessory UUID, no transplanted files).
 *   --smoke-service <key>     Service of the smoke accessory (default TemperatureAccessory).
 *   --event-port-base <port>  XML-RPC callback port of the block (multi-bridge), or of
 *                             block i = base+i in the full bridge order. Default 9875.
 *   --base <file.json>        Copy ccuIp, useTls, ccuAuth, interfaces and
 *                             interfacePorts from this JSON object (e.g. the
 *                             current platform block, or a full Homebridge
 *                             config.json, whose HomematicHap block is used).
 *   --ccu-ip <host>           CCU address (when --base is not given).
 *   --out <file.json>         Write the block(s) here (mode 0600) instead of stdout.
 *   --persist-out <dir>       Copy AccessoryInfo.*.json and IdentifierCache.*.json of
 *                             the bridges here (mode 0600). Multi-bridge: all listed
 *                             bridges, or only those named by --persist-bridge.
 *   --persist-bridge <name>   Restrict --persist-out to this bridge; repeatable.
 *   --preserve-identity       --per-bridge-blocks only (multi-bridge preserves unless
 *                             --new-identities).
 *   --new-identities          Multi-bridge: give every bridge a NEW HomeKit identity
 *                             instead of transplanting the hap-homematic one, so the
 *                             old bridges can stay paired and running until the new
 *                             ones are paired (newIdentity=true, no bridge UUID, no
 *                             hap-homematic accessory UUIDs). Username and port derive
 *                             from the instance id (stable across runs); pin and
 *                             setupID are random. Bridges already in the --base
 *                             block (same name, newIdentity) keep their username,
 *                             pin, setupID, port and enabled state, so a re-run
 *                             changes nothing. Their ports are reserved before any
 *                             new port is assigned, so a kept bridge never moves.
 *   --host-bridge-from-base   Multi-bridge: keep the --base block's _bridge (name,
 *                             username, port), e.g. the existing child bridge.
 *   --reserve-ports <list>    --new-identities: comma-separated HAP ports already used
 *                             by other Homebridge child bridges; new bridges avoid
 *                             them. Repeatable. With a full Homebridge config.json as
 *                             --base these are read from it (every other _bridge.port,
 *                             the main bridge port and the bridge ports of other
 *                             HomematicHap blocks) and this flag adds to them.
 *   --keep-enabled            --new-identities: a bridge whose --base identity had to
 *                             be discarded (old hap-homematic username, missing pin,
 *                             username or port) is listed disabled, because it needs
 *                             a new pairing; this flag keeps its enabled state.
 *
 * The output contains pairing pins and, with --base, CCU credentials.
 * Treat it like a password file. Nothing secret is printed.
 */

import { Buffer } from 'node:buffer';
import { randomInt } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { list as tarList } from 'tar';

const here = path.dirname(fileURLToPath(import.meta.url));
const { importBackupTarball, splitReportIntoBridges, bridgeIdentityFor } = await import(
  path.join(here, '..', 'dist', 'src', 'import', 'HapHomematicImporter.js')
);

function parseArgs(argv) {
  const opts = { bridges: [], enable: [], persistBridges: [], reservePorts: [], eventPortBase: 9875, name: 'HomeMatic Bridges', advertiser: 'ciao', smokeService: 'TemperatureAccessory' };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--preserve-identity') opts.preserveIdentity = true;
    else if (a === '--new-identities') opts.newIdentities = true;
    else if (a === '--host-bridge-from-base') opts.hostBridgeFromBase = true;
    else if (a === '--keep-enabled') opts.keepEnabled = true;
    else if (a === '--reserve-ports') opts.reservePorts.push(...next().split(',').map((x) => x.trim()).filter(Boolean));
    else if (a === '--per-bridge-blocks') opts.perBridgeBlocks = true;
    else if (a === '--bridge') opts.bridges.push(next());
    else if (a === '--enable') opts.enable.push(next());
    else if (a === '--name') opts.name = next();
    else if (a === '--advertiser') opts.advertiser = next();
    else if (a === '--smoke-bridge') opts.smokeBridge = next();
    else if (a === '--smoke-service') opts.smokeService = next();
    else if (a === '--event-port-base') opts.eventPortBase = Number(next());
    else if (a === '--base') opts.base = next();
    else if (a === '--ccu-ip') opts.ccuIp = next();
    else if (a === '--out') opts.out = next();
    else if (a === '--persist-out') opts.persistOut = next();
    else if (a === '--persist-bridge') opts.persistBridges.push(next());
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a.startsWith('--')) throw new Error(`Unknown option ${a}`);
    else rest.push(a);
  }
  opts.backup = rest[0];
  return opts;
}

async function readPersistFiles(tarball, wanted) {
  const found = new Map();
  await new Promise((resolve, reject) => {
    const parser = tarList({
      filter: (p) => wanted.has(p.replace(/^\.\//, '')),
      onReadEntry: (entry) => {
        const chunks = [];
        entry.on('data', (c) => chunks.push(c));
        entry.on('end', () => found.set(entry.path.replace(/^\.\//, ''), Buffer.concat(chunks)));
      },
    });
    parser.on('end', resolve);
    parser.on('error', reject);
    Readable.from(tarball).pipe(parser);
  });
  return found;
}

/** A valid HAP setup code that is not one of the trivial ones HAP rejects. */
function randomPin() {
  for (;;) {
    const d = Array.from({ length: 8 }, () => randomInt(10)).join('');
    if (!/^(\d)\1{7}$/.test(d) && d !== '12345678' && d !== '87654321') {
      return `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`;
    }
  }
}

/** A random HAP setupID (4 characters 0-9 A-Z). */
function randomSetupId() {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  return Array.from({ length: 4 }, () => chars[randomInt(chars.length)]).join('');
}

/**
 * The identity a bridge already has in the --base block, if it can be kept:
 * newIdentity, with username, pin and port, and not one of the hap-homematic
 * usernames (those stay paired meanwhile). Otherwise `{ discarded: <reason> }`
 * when the base has an entry for the bridge, or undefined when it has none.
 */
function keptIdentityFor(previous, oldUsernames) {
  if (!previous) return undefined;
  if (previous.newIdentity !== true) return { discarded: 'it is not a new-identity bridge' };
  const missing = ['username', 'pincode', 'port'].filter((k) => !previous[k]);
  if (missing.length > 0) return { discarded: `it has no ${missing.join(', ')}` };
  const kept = { username: String(previous.username).toUpperCase(), pincode: previous.pincode, port: previous.port };
  if (previous.setupID) kept.setupID = previous.setupID;
  if (oldUsernames.has(kept.username)) return { discarded: 'its username is a hap-homematic username' };
  return { kept };
}

/**
 * New identity for a hap-homematic bridge: the plugin's deterministic
 * username and port for the instance id (bridgeIdentityFor), a fresh pin
 * and setupID. Never one of the hap-homematic usernames, which stay paired
 * meanwhile.
 */
function freshIdentityFor(b, oldUsernames) {
  let { username, port } = b.bridge;
  for (let i = 1; oldUsernames.has(username.toUpperCase()); i++) {
    ({ username, port } = bridgeIdentityFor(`${b.instanceUuid}:${i}`));
  }
  return { username, pincode: randomPin(), setupID: randomSetupId(), port };
}

/** The HomematicHap platform block of a full Homebridge config.json, else the object itself. */
function baseBlockOf(base, blockName) {
  if (!Array.isArray(base.platforms)) return { block: base, others: [] };
  const mine = base.platforms.filter((p) => p?.platform === 'HomematicHap');
  const block = mine.find((p) => p.name === blockName) ?? mine[0] ?? {};
  return { block, others: [base.bridge, ...base.platforms, ...(base.accessories ?? [])].filter((x) => x && x !== block) };
}

/** HAP ports of other child bridges (and bridges of other HomematicHap blocks) in a full config. */
function portsUsedByOthers(others) {
  const ports = [];
  for (const x of others) {
    ports.push(x.port, x._bridge?.port);
    for (const mb of x.multiBridge?.bridges ?? []) ports.push(mb?.port);
  }
  return ports.filter((p) => Number.isInteger(p));
}

function writeSecretFile(file, text) {
  fs.writeFileSync(file, text, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help || !opts.backup) {
  process.stderr.write('usage: hap-homematic-to-config.mjs <backup.tar.gz> [--per-bridge-blocks [--preserve-identity]] [--bridge <name>]... '
    + '[--enable <name>]... [--new-identities] [--host-bridge-from-base] [--name <block>] [--advertiser ciao] [--smoke-bridge <address>] '
    + '[--event-port-base 9875] [--base block.json | --ccu-ip host] [--out file] [--persist-out dir [--persist-bridge <name>]...]\n');
  process.exit(opts.help ? 0 : 2);
}
if (!Number.isInteger(opts.eventPortBase) || opts.eventPortBase < 1024 || opts.eventPortBase > 65000) {
  throw new Error('--event-port-base must be an integer in [1024, 65000]');
}
const multi = !opts.perBridgeBlocks;
if (!multi && (opts.enable.length || opts.smokeBridge || opts.newIdentities || opts.hostBridgeFromBase)) {
  throw new Error('--enable, --smoke-bridge, --new-identities and --host-bridge-from-base need the multi-bridge layout');
}
if (opts.newIdentities && opts.persistOut) {
  throw new Error('--persist-out copies the hap-homematic pairing files; it does not go with --new-identities');
}
if (opts.hostBridgeFromBase && !opts.base) {
  throw new Error('--host-bridge-from-base needs --base');
}
if (opts.newIdentities && opts.smokeBridge) {
  throw new Error('--smoke-bridge is for the transplant layout; with --new-identities every bridge is already new');
}
const reservePorts = opts.reservePorts.map(Number);
if (reservePorts.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)) {
  throw new Error('--reserve-ports needs a comma-separated list of ports in [1, 65535]');
}
if ((opts.reservePorts.length > 0 || opts.keepEnabled) && !(multi && opts.newIdentities)) {
  throw new Error('--reserve-ports and --keep-enabled need --new-identities');
}
const preserve = (multi && !opts.newIdentities) || opts.preserveIdentity === true;

const tarball = fs.readFileSync(opts.backup);
const report = await importBackupTarball(tarball);
const all = splitReportIntoBridges(report, { preserveIdentity: preserve });
const instances = report.meta.instances;
const instanceName = (b) => instances[b.instanceUuid]?.name;
const knownNames = new Set(all.map(instanceName));
for (const [flag, names] of [['--bridge', opts.bridges], ['--enable', opts.enable], ['--persist-bridge', opts.persistBridges]]) {
  const unknown = names.filter((n) => !knownNames.has(n));
  if (unknown.length > 0) {
    throw new Error(`${flag}: no non-empty hap-homematic bridge named: ${unknown.join(', ')}`);
  }
}

const baseFile = opts.base ? JSON.parse(fs.readFileSync(opts.base, 'utf8')) : {};
const { block: base, others: otherBlocks } = baseBlockOf(baseFile, opts.name);
const pick = (k) => (base[k] !== undefined ? { [k]: base[k] } : {});
const ccuIp = base.ccuIp ?? opts.ccuIp;
if (!ccuIp) {
  throw new Error('Give --base (with ccuIp) or --ccu-ip');
}
const wantedNames = new Set(opts.bridges);
const selected = all
  .map((b, index) => ({ b, index }))
  .filter(({ b }) => wantedNames.size === 0 || wantedNames.has(instanceName(b)));
const common = () => ({
  ccuIp,
  ...pick('useTls'),
  ...pick('ccuAuth'),
  ...pick('interfaces'),
  ...pick('interfacePorts'),
});
const eventServer = (port) => ({ host: base.eventServer?.host ?? '0.0.0.0', port, watchdogSeconds: base.eventServer?.watchdogSeconds ?? 300 });

let output;
let persistFor;
let summary;
if (multi && opts.newIdentities) {
  const enable = new Set(opts.enable);
  const previous = new Map((base.multiBridge?.bridges ?? []).map((x) => [x.name, x]));
  const oldUsernames = new Set(Object.values(instances).map((i) => String(i.user ?? '').toUpperCase()).filter(Boolean));
  const hostBridge = opts.hostBridgeFromBase ? base._bridge : undefined;
  if (opts.hostBridgeFromBase && (typeof hostBridge?.username !== 'string' || !Number.isInteger(hostBridge?.port))) {
    throw new Error('--host-bridge-from-base: the --base block has no _bridge with username and port');
  }
  // Ports a new bridge must not take: the event server, the host bridge, other
  // child bridges, and every bridge kept from --base (a kept bridge never moves).
  const taken = new Set([
    opts.eventPortBase,
    hostBridge?.port ?? bridgeIdentityFor(`multiBridge:${opts.name}`).port,
    ...reservePorts,
    ...portsUsedByOthers(otherBlocks),
  ].filter(Boolean));
  const decided = selected.map(({ b }) => ({ b, found: keptIdentityFor(previous.get(b.name), oldUsernames) }));
  for (const { found } of decided) {
    if (found?.kept) taken.add(found.kept.port);
  }
  const bridges = decided.map(({ b, found }) => {
    const prev = previous.get(b.name);
    const id = found?.kept ?? freshIdentityFor(b, oldUsernames);
    if (!found?.kept) {
      while (taken.has(id.port)) id.port += 1;
      taken.add(id.port);
    }
    const discarded = found?.discarded !== undefined;
    if (discarded) {
      process.stderr.write(`warning: bridge "${b.name}": the identity in --base was discarded (${found.discarded}); `
        + `it gets a new username, pin and port and needs a new pairing`
        + `${opts.keepEnabled ? '' : '; it is listed disabled (--keep-enabled keeps its state)'}\n`);
    }
    const wanted = enable.has(instanceName(b)) || (prev?.newIdentity === true && prev.enabled === true);
    const entry = {
      name: b.name,
      // A bridge kept from --base stays enabled: disabling it would take a
      // paired bridge off the network. One whose identity was discarded is
      // not paired any more, so it is not published until asked for.
      enabled: discarded && !opts.keepEnabled ? false : wanted,
      newIdentity: true,
      hapHomematicIdentity: false,
      username: id.username,
      pincode: id.pincode,
      port: id.port,
      channels: b.channels,
      variables: b.variables,
      programs: b.programs,
    };
    if (id.setupID) entry.setupID = id.setupID;
    return entry;
  });
  const host = hostBridge
    ? { ...(hostBridge.name ? { name: hostBridge.name } : {}), username: hostBridge.username, port: hostBridge.port }
    : { name: opts.name, ...bridgeIdentityFor(`multiBridge:${opts.name}`) };
  output = [{
    platform: 'HomematicHap',
    name: opts.name,
    ...common(),
    eventServer: eventServer(opts.eventPortBase),
    multiBridge: { advertiser: opts.advertiser, bridges },
    _bridge: host,
  }];
  persistFor = [];
  summary = `1 multi-bridge block, ${bridges.length} bridge(s), ${bridges.filter((x) => x.enabled).length} enabled, new identities`;
} else if (multi) {
  const enable = new Set(opts.enable);
  const bridges = selected.map(({ b }) => {
    const entry = {
      name: b.name,
      enabled: enable.has(instanceName(b)),
      username: b.bridge.username,
      pincode: b.bridge.pin,
      port: b.bridge.port,
      bridgeUuid: b.instanceUuid,
      channels: b.channels,
      variables: b.variables,
      programs: b.programs,
    };
    if (b.bridge.setupID) {
      entry.setupID = b.bridge.setupID;
    }
    if (!entry.pincode) {
      throw new Error(`hap-homematic bridge "${instanceName(b)}" has no pin; cannot transplant it`);
    }
    return entry;
  });
  if (opts.smokeBridge) {
    const id = bridgeIdentityFor(`smoke-test:${opts.name}`);
    const ports = new Set(bridges.map((x) => x.port));
    let port = id.port;
    while (ports.has(port) || port === opts.eventPortBase) port += 1;
    bridges.push({
      name: 'HomeMatic Smoke Test',
      enabled: false,
      newIdentity: true,
      hapHomematicIdentity: false,
      username: id.username,
      pincode: randomPin(),
      port,
      channels: [{ address: opts.smokeBridge, service: opts.smokeService, name: 'Smoke Test Sensor' }],
      variables: [],
      programs: [],
    });
  }
  const host = bridgeIdentityFor(`multiBridge:${opts.name}`);
  output = [{
    platform: 'HomematicHap',
    name: opts.name,
    ...common(),
    eventServer: eventServer(opts.eventPortBase),
    multiBridge: { advertiser: opts.advertiser, bridges },
    _bridge: { name: opts.name, username: host.username, port: host.port },
  }];
  const persistNames = new Set(opts.persistBridges);
  persistFor = selected
    .filter(({ b }) => persistNames.size === 0 || persistNames.has(instanceName(b)))
    .map(({ b }) => b.bridge.username);
  summary = `1 multi-bridge block, ${bridges.length} bridge(s), ${bridges.filter((x) => x.enabled).length} enabled`;
} else {
  output = selected.map(({ b, index }) => ({
    platform: 'HomematicHap',
    name: b.name,
    ...common(),
    eventServer: eventServer(opts.eventPortBase + index),
    hapHomematicIdentity: b.hapHomematicIdentity,
    _bridge: { name: b.name, ...b.bridge },
    channels: b.channels,
    variables: b.variables,
    programs: b.programs,
  }));
  if (opts.persistOut && !opts.preserveIdentity) {
    throw new Error('--persist-out only makes sense with --preserve-identity');
  }
  persistFor = output.map((block) => block._bridge.username);
  summary = `${output.length} block(s)`;
}

const json = `${JSON.stringify(output, null, 2)}\n`;
if (opts.out) {
  writeSecretFile(opts.out, json);
} else {
  process.stdout.write(json);
}

if (opts.persistOut) {
  fs.mkdirSync(opts.persistOut, { recursive: true, mode: 0o700 });
  const wanted = new Set();
  for (const username of persistFor) {
    const id = username.replace(/:/g, '').toUpperCase();
    wanted.add(`persist/AccessoryInfo.${id}.json`);
    wanted.add(`persist/IdentifierCache.${id}.json`);
  }
  const files = await readPersistFiles(tarball, wanted);
  const missing = [...wanted].filter((w) => !files.has(w));
  if (missing.length > 0) {
    throw new Error(`Backup lacks: ${missing.join(', ')}`);
  }
  for (const [name, buf] of files) {
    writeSecretFile(path.join(opts.persistOut, path.basename(name)), buf);
  }
  summary += `, ${files.size} persist file(s)`;
}

const mappings = selected.reduce((n, { b }) => n + b.channels.length + b.variables.length + b.programs.length, 0);
process.stderr.write(`${summary}, ${mappings} mapping(s)`
  + `${report.warnings.length ? `, ${report.warnings.length} import warning(s):\n  ${report.warnings.join('\n  ')}` : ''}\n`);

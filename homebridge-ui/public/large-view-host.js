/**
 * Dialog side of the large view (issue Home#614), Homematic specific.
 *
 * The large view page never gets the plugin config itself: it gets a
 * snapshot (bridge names and channel mappings, no ccuAuth) and sends back a
 * list of channel operations. This module checks those operations and
 * applies them to a copy of the dialog's own blocks, so ccuAuth and every
 * other field the page cannot see stay exactly as they were.
 *
 * Pure functions only; app.js does the side effects (updatePluginConfig).
 */

import { revisionOf, stripKeys } from './kit/link.js';

/** Top-level block keys that never leave the dialog. */
export const SECRET_KEYS = Object.freeze(['ccuAuth']);

const MAX_OPS = 5000;
const MAX_NAME = 128;
const ADDRESS_RE = /^[A-Za-z0-9._:-]{1,80}$/;
const EDITED_FIELDS = ['address', 'name', 'service', 'subtype', 'settings', '_info'];

/**
 * Fields of an existing mapping that an edit does not touch. The HomeKit
 * identity seed only survives while the entry stays on its bridge.
 */
export function keptFields(entry, sameBridge, edited) {
  if (!entry) return {};
  const out = {};
  for (const [k, v] of Object.entries(entry)) {
    if (edited.includes(k)) continue;
    if (k === 'uuidSeed' && !sameBridge) continue;
    out[k] = v;
  }
  return out;
}

/** Revision of the dialog's config as the page sees it (credentials excluded). */
export function configRevision(blocks) {
  return revisionOf(stripKeys(blocks, SECRET_KEYS));
}

/** What the page gets: no credentials, no bridge identities, no CCU settings. */
export function buildSnapshot(state) {
  const safe = stripKeys(state.blocks, SECRET_KEYS);
  return {
    revision: configRevision(state.blocks),
    blocks: safe.map((b) => ({ name: b.name, channels: b.channels ?? [] })),
    services: state.services?.channelServices ?? [],
    devices: state.discovered?.devices ?? [],
    pluginVersion: state.pluginVersion ?? 'unknown',
  };
}

function invalid(error) {
  return { ok: false, code: 'invalid', error };
}

function checkSet(op, blocks, services) {
  if (typeof op.name !== 'string' || !op.name.trim() || op.name.trim().length > MAX_NAME) {
    return `${op.address}: Name fehlt oder ist zu lang`;
  }
  const def = services.find((s) => s.key === op.service);
  if (!def) return `${op.address}: unbekannter Dienst ${String(op.service)}`;
  // No subtype is valid: the service then uses its default variant (as
  // entries saved by the dialog editor without a variant choice do).
  const variants = def.variants ?? [];
  const hasSubtype = op.subtype !== undefined && op.subtype !== null && op.subtype !== '';
  if (hasSubtype && !variants.some((v) => v.id === op.subtype)) {
    return `${op.address}: unbekannte Variante ${String(op.subtype)}`;
  }
  if (!Number.isInteger(op.bridgeIndex) || op.bridgeIndex < 0 || op.bridgeIndex >= blocks.length) {
    return `${op.address}: ungültige Bridge`;
  }
  return null;
}

function findChannel(blocks, address) {
  for (let bi = 0; bi < blocks.length; bi++) {
    const i = (blocks[bi].channels ?? []).findIndex((c) => c.address === address);
    if (i !== -1) return { bi, i, entry: blocks[bi].channels[i] };
  }
  return null;
}

function applySet(blocks, op) {
  const found = findChannel(blocks, op.address);
  const sameBridge = !!found && found.bi === op.bridgeIndex;
  const def = {
    ...keptFields(found?.entry, sameBridge, EDITED_FIELDS),
    address: op.address,
    name: op.name.trim(),
    service: op.service,
    ...(op.subtype ? { subtype: op.subtype } : {}),
    ...(found?.entry?.settings ? { settings: found.entry.settings } : {}),
  };
  if (sameBridge) {
    blocks[found.bi].channels[found.i] = def;
    return;
  }
  if (found) blocks[found.bi].channels.splice(found.i, 1);
  blocks[op.bridgeIndex].channels.push(def);
}

/**
 * Checks an Apply from the page and returns the new blocks, or why not.
 * `msg` = { revision, ops: [{ op: 'set', address, name, service, subtype?, bridgeIndex } | { op: 'remove', address }] }.
 * Never mutates `state`.
 */
export function processApply(state, msg) {
  if (!msg || typeof msg !== 'object' || !Array.isArray(msg.ops)) return invalid('Ungültige Anfrage');
  if (msg.revision !== configRevision(state.blocks)) {
    return { ok: false, code: 'stale', error: 'Die Konfiguration wurde inzwischen geändert' };
  }
  if (msg.ops.length > MAX_OPS) return invalid('Zu viele Änderungen');
  const services = state.services?.channelServices ?? [];
  const blocks = structuredClone(state.blocks).map((b) => ({ ...b, channels: b.channels ?? [] }));
  const seen = new Set();
  for (const op of msg.ops) {
    if (!op || typeof op !== 'object' || typeof op.address !== 'string' || !ADDRESS_RE.test(op.address)) {
      return invalid('Ungültige Kanaladresse');
    }
    if (seen.has(op.address)) return invalid(`${op.address}: doppelt`);
    seen.add(op.address);
    if (op.op === 'remove') {
      const found = findChannel(blocks, op.address);
      if (!found) return invalid(`${op.address}: nicht in HomeKit`);
      blocks[found.bi].channels.splice(found.i, 1);
    } else if (op.op === 'set') {
      if (!services.length) return invalid('Die Dienstliste ist nicht geladen');
      const err = checkSet(op, blocks, services);
      if (err) return invalid(err);
      applySet(blocks, op);
    } else {
      return invalid(`${op.address}: unbekannte Operation`);
    }
  }
  return { ok: true, blocks };
}

/**
 * Apply plus staging: `stage(blocks)` is the dialog's updatePluginConfig
 * call. The page hears "ok" only after Homebridge took the new config; on a
 * rejection it hears why and the dialog keeps its old blocks.
 * Returns { blocks?, reply } where reply goes to the page as "applied".
 */
export async function applyAndStage(state, msg, stage) {
  const result = processApply(state, msg);
  if (!result.ok) return { reply: { ok: false, code: result.code, error: result.error } };
  try {
    await stage(result.blocks);
  } catch (err) {
    return { reply: { ok: false, code: 'failed', error: `Homebridge hat die Änderungen nicht angenommen: ${err?.message ?? String(err)}` } };
  }
  return { blocks: result.blocks, reply: { ok: true, count: msg.ops.length } };
}

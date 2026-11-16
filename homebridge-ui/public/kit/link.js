/* home-ui-kit link.js 1.0.0 sha256:2459f14371c23a15a75ba2ea6c4830a245acd4a46a7ab08eac62e34bbdefd2b3 */
/**
 * home-ui-kit: the postMessage link between a Homebridge plugin settings
 * dialog (the custom UI iframe) and its large view page (a popup the iframe
 * opened with window.open). Shared by the owner's plugins as a copied
 * folder; scripts/kit-hash.mjs checks that the copy matches the header.
 *
 * Rules:
 *  - The dialog accepts a message only when `event.source` is the popup it
 *    opened and `event.origin` is the page origin the plugin server returned.
 *  - The page accepts a message only when `event.source` is `window.opener`
 *    and `event.origin` is the dialog origin the plugin server put into the
 *    page.
 *  - Both sides post with an exact target origin, never '*'.
 *  - Secrets never cross the link: the dialog strips them before sending
 *    (stripKeys) and adds them back on its own side.
 */

export const KIT_VERSION = '1.0.0';
export const PROTOCOL = 'home-ui-kit/1';

function isTagged(data) {
  return !!data && typeof data === 'object' && data.protocol === PROTOCOL && typeof data.type === 'string';
}

function exactOrigin(origin) {
  if (typeof origin !== 'string' || origin === '*' || origin === 'null' || !/^https?:\/\//.test(origin)) {
    throw new Error(`home-ui-kit: invalid origin ${origin}`);
  }
  return origin;
}

/**
 * Dialog side. `popup` is the WindowProxy returned by window.open.
 * Returns { send(type, body), close() }.
 */
export function createOpenerLink({ win = globalThis.window, popup, pageOrigin, onMessage }) {
  if (!popup) throw new Error('home-ui-kit: no popup window');
  const origin = exactOrigin(pageOrigin);
  let open = true;
  const listener = (event) => {
    if (!open || event.source !== popup || event.origin !== origin || !isTagged(event.data)) return;
    onMessage(event.data);
  };
  win.addEventListener('message', listener);
  return {
    send(type, body = {}) {
      if (!open || popup.closed) return;
      popup.postMessage({ ...body, protocol: PROTOCOL, type }, origin);
    },
    close() {
      open = false;
      win.removeEventListener('message', listener);
    },
  };
}

/**
 * Page side. Returns null when the page was not opened by the dialog.
 * Returns { send(type, body), close(), openerClosed() }.
 */
export function createPageLink({ win = globalThis.window, openerOrigin, onMessage }) {
  const opener = win.opener;
  if (!opener) return null;
  const origin = exactOrigin(openerOrigin);
  let open = true;
  const listener = (event) => {
    if (!open || event.source !== opener || event.origin !== origin || !isTagged(event.data)) return;
    onMessage(event.data);
  };
  win.addEventListener('message', listener);
  return {
    send(type, body = {}) {
      if (!open || opener.closed) return;
      opener.postMessage({ ...body, protocol: PROTOCOL, type }, origin);
    },
    close() {
      open = false;
      win.removeEventListener('message', listener);
    },
    openerClosed() {
      return !!opener.closed;
    },
  };
}

/** JSON with sorted object keys, so equal content gives equal text. */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v === undefined ? null : v)).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Revision of a value: a 53-bit hash (cyrb53) of its stable JSON, as 14 hex
 * digits. Detects a stale Apply; it is not a security check (crypto.subtle
 * is unavailable on plain-http LAN pages).
 */
export function revisionOf(value) {
  const str = stableStringify(value);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return n.toString(16).padStart(14, '0');
}

/** Copies of the blocks without the given top-level keys (for example ccuAuth). */
export function stripKeys(blocks, keys) {
  return (blocks ?? []).map((block) => {
    const out = { ...block };
    for (const k of keys) delete out[k];
    return out;
  });
}

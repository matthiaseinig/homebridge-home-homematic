import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain browser ES module without types
import { PROTOCOL, createOpenerLink, createPageLink, revisionOf, stableStringify, stripKeys } from '../../homebridge-ui/public/kit/link.js';

/** Minimal stand-in for a browser window: listeners, postMessage, opener. */
function fakeWindow(opener: unknown = null) {
  const listeners = new Set<(e: unknown) => void>();
  return {
    opener,
    closed: false,
    posted: [] as { msg: any; origin: string }[],
    addEventListener: (_t: string, fn: (e: unknown) => void) => listeners.add(fn),
    removeEventListener: (_t: string, fn: (e: unknown) => void) => listeners.delete(fn),
    dispatch(e: unknown) { for (const fn of [...listeners]) fn(e); },
    postMessage(msg: unknown, origin: string) { this.posted.push({ msg, origin }); },
    get listenerCount() { return listeners.size; },
  };
}

const DIALOG = 'http://10.0.0.5:8581';
const PAGE = 'http://10.0.0.5:40123';

describe('kit link: dialog (opener) side', () => {
  it('accepts a message only from its own popup and the page origin', () => {
    const iframe = fakeWindow();
    const popup = fakeWindow();
    const other = fakeWindow();
    const onMessage = vi.fn();
    createOpenerLink({ win: iframe, popup, pageOrigin: PAGE, onMessage });

    const data = { protocol: PROTOCOL, type: 'hello' };
    iframe.dispatch({ source: other, origin: PAGE, data });                     // wrong window
    iframe.dispatch({ source: popup, origin: 'http://10.0.0.5:40124', data });   // wrong origin
    iframe.dispatch({ source: popup, origin: 'null', data });                    // opaque origin
    iframe.dispatch({ source: popup, origin: PAGE, data: { type: 'hello' } });   // no protocol tag
    iframe.dispatch({ source: popup, origin: PAGE, data: { protocol: PROTOCOL } }); // no type
    expect(onMessage).not.toHaveBeenCalled();

    iframe.dispatch({ source: popup, origin: PAGE, data });
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0]![0]).toEqual(data);
  });

  it('posts only to the page origin, never to "*"', () => {
    const iframe = fakeWindow();
    const popup = fakeWindow();
    const link = createOpenerLink({ win: iframe, popup, pageOrigin: PAGE, onMessage: () => undefined });
    link.send('snapshot', { revision: 'r1' });
    expect(popup.posted).toEqual([{ msg: { protocol: PROTOCOL, type: 'snapshot', revision: 'r1' }, origin: PAGE }]);
  });

  it('close() removes the listener and stops sending', () => {
    const iframe = fakeWindow();
    const popup = fakeWindow();
    const onMessage = vi.fn();
    const link = createOpenerLink({ win: iframe, popup, pageOrigin: PAGE, onMessage });
    link.close();
    expect(iframe.listenerCount).toBe(0);
    iframe.dispatch({ source: popup, origin: PAGE, data: { protocol: PROTOCOL, type: 'hello' } });
    link.send('snapshot', {});
    expect(onMessage).not.toHaveBeenCalled();
    expect(popup.posted).toEqual([]);
  });

  it('refuses to start without a popup or with a wildcard origin', () => {
    const iframe = fakeWindow();
    expect(() => createOpenerLink({ win: iframe, popup: null, pageOrigin: PAGE, onMessage: () => undefined })).toThrow();
    expect(() => createOpenerLink({ win: iframe, popup: fakeWindow(), pageOrigin: '*', onMessage: () => undefined })).toThrow();
  });
});

describe('kit link: page side', () => {
  it('accepts a message only from window.opener and the dialog origin', () => {
    const iframe = fakeWindow();
    const page = fakeWindow(iframe);
    const onMessage = vi.fn();
    createPageLink({ win: page, openerOrigin: DIALOG, onMessage });

    const data = { protocol: PROTOCOL, type: 'snapshot' };
    page.dispatch({ source: fakeWindow(), origin: DIALOG, data });  // not the opener
    page.dispatch({ source: iframe, origin: 'http://evil.example', data });
    page.dispatch({ source: page, origin: PAGE, data });            // itself
    expect(onMessage).not.toHaveBeenCalled();

    page.dispatch({ source: iframe, origin: DIALOG, data });
    expect(onMessage).toHaveBeenCalledWith(data);
  });

  it('posts only to the opener with the dialog origin', () => {
    const iframe = fakeWindow();
    const page = fakeWindow(iframe);
    const link = createPageLink({ win: page, openerOrigin: DIALOG, onMessage: () => undefined });
    link.send('hello', {});
    expect(iframe.posted).toEqual([{ msg: { protocol: PROTOCOL, type: 'hello' }, origin: DIALOG }]);
  });

  it('is null when the page has no opener (opened directly)', () => {
    expect(createPageLink({ win: fakeWindow(null), openerOrigin: DIALOG, onMessage: () => undefined })).toBeNull();
  });
});

describe('kit helpers', () => {
  it('stableStringify ignores key order; revisionOf follows content', () => {
    expect(stableStringify({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(stableStringify({ a: [{ c: 3, d: 2 }], b: 1 }));
    const r1 = revisionOf([{ name: 'x', channels: [] }]);
    expect(r1).toBe(revisionOf([{ channels: [], name: 'x' }]));
    expect(r1).not.toBe(revisionOf([{ name: 'y', channels: [] }]));
    expect(r1).toMatch(/^[0-9a-f]{14}$/);
  });

  it('stripKeys removes the keys from every block without touching the input', () => {
    const blocks = [{ name: 'a', ccuAuth: { password: 'pw' } }, { name: 'b' }];
    expect(stripKeys(blocks, ['ccuAuth'])).toEqual([{ name: 'a' }, { name: 'b' }]);
    expect(blocks[0]!.ccuAuth).toEqual({ password: 'pw' });
  });
});

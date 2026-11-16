/**
 * Owns the one large-view listener of a custom UI server child: starts it on
 * `/large-view/info`, reuses it while the same dialog asks again, stops it on
 * `/large-view/stop`, and closes it when the dialog closes (config-ui-x
 * disconnects the IPC channel, then sends SIGTERM).
 */
import { LargeViewError, type LargeViewDeps, type LargeViewServerOptions, type LargeViewStarted } from './largeViewServer.js';
export interface LargeViewControllerOptions extends LargeViewDeps {
    indexFile: string;
    assets: LargeViewServerOptions['assets'];
}
export interface LargeViewInfo extends LargeViewStarted {
    /** The dialog origin the page accepts messages from. */
    openerOrigin: string;
}
/** The parts of `process` the shutdown hooks use (a fake in tests). */
export interface ShutdownProcess {
    on(event: 'SIGTERM' | 'disconnect', listener: () => void): unknown;
}
export declare class LargeViewController {
    private readonly opts;
    private server;
    private started;
    private pending;
    /** Bumped by stop(); a start begun before it is cancelled. */
    private generation;
    constructor(opts: LargeViewControllerOptions);
    get running(): boolean;
    /** Handler of `/large-view/info`: `{ origin }` is the dialog iframe's `location.origin`. */
    info(payload: unknown): Promise<LargeViewInfo>;
    private ensure;
    /**
     * Handler of `/large-view/stop` and of the shutdown hooks. Also cancels a
     * start that is still in flight: when this resolves, nothing listens.
     */
    stop(): Promise<{
        stopped: boolean;
    }>;
    private stopServer;
    /**
     * Closes the listener when the dialog closes. plugin-ui-utils answers an
     * IPC disconnect with SIGTERM to itself; a SIGTERM listener replaces Node's
     * default exit, so this one exits once the listener is closed (or after
     * `graceMs`).
     */
    installShutdownHooks(proc: ShutdownProcess, exit: (code: number) => void, graceMs?: number): void;
}
export { LargeViewError };

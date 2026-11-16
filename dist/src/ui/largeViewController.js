/**
 * Owns the one large-view listener of a custom UI server child: starts it on
 * `/large-view/info`, reuses it while the same dialog asks again, stops it on
 * `/large-view/stop`, and closes it when the dialog closes (config-ui-x
 * disconnects the IPC channel, then sends SIGTERM).
 */
import { LargeViewError, LargeViewServer, parseOpenerOrigin, } from './largeViewServer.js';
export class LargeViewController {
    opts;
    server = null;
    started = null;
    pending = null;
    constructor(opts) {
        this.opts = opts;
    }
    get running() {
        return this.server?.running ?? false;
    }
    /** Handler of `/large-view/info`: `{ origin }` is the dialog iframe's `location.origin`. */
    info(payload) {
        const origin = payload?.origin;
        parseOpenerOrigin(origin);
        // Serialise: two quick clicks must not start two listeners.
        const run = (this.pending ?? Promise.resolve()).catch(() => undefined).then(() => this.ensure(origin));
        this.pending = run;
        return run;
    }
    async ensure(origin) {
        if (this.server?.running && this.started && this.server.openerOrigin === origin) {
            return { ...this.started, openerOrigin: origin };
        }
        await this.stop();
        const server = await LargeViewServer.create({ ...this.opts, openerOrigin: origin });
        const started = await server.start();
        this.server = server;
        this.started = started;
        return { ...started, openerOrigin: origin };
    }
    /** Handler of `/large-view/stop` and of the shutdown hooks. */
    async stop() {
        const server = this.server;
        this.server = null;
        this.started = null;
        if (!server)
            return { stopped: false };
        await server.stop();
        return { stopped: true };
    }
    /**
     * Closes the listener when the dialog closes. plugin-ui-utils answers an
     * IPC disconnect with SIGTERM to itself; a SIGTERM listener replaces Node's
     * default exit, so this one exits once the listener is closed (or after
     * `graceMs`).
     */
    installShutdownHooks(proc, exit, graceMs = 1000) {
        let exiting = false;
        const shutdown = () => {
            if (exiting)
                return;
            exiting = true;
            const timer = setTimeout(() => exit(0), graceMs);
            void this.stop().finally(() => {
                clearTimeout(timer);
                exit(0);
            });
        };
        proc.on('disconnect', () => void this.stop());
        proc.on('SIGTERM', shutdown);
    }
}
export { LargeViewError };
//# sourceMappingURL=largeViewController.js.map
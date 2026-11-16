/**
 * Owns the one large-view listener of a custom UI server child: starts it on
 * `/large-view/info`, reuses it while the same dialog asks again, stops it on
 * `/large-view/stop`, and closes it when the dialog closes (config-ui-x
 * disconnects the IPC channel, then sends SIGTERM).
 */

import {
  LargeViewError,
  LargeViewServer,
  parseOpenerOrigin,
  type LargeViewDeps,
  type LargeViewServerOptions,
  type LargeViewStarted,
} from './largeViewServer.js';

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

export class LargeViewController {
  private server: LargeViewServer | null = null;
  private started: LargeViewStarted | null = null;
  private pending: Promise<LargeViewInfo> | null = null;
  /** Bumped by stop(); a start begun before it is cancelled. */
  private generation = 0;

  constructor(private readonly opts: LargeViewControllerOptions) {}

  get running(): boolean {
    return this.server?.running ?? false;
  }

  /** Handler of `/large-view/info`: `{ origin }` is the dialog iframe's `location.origin`. */
  info(payload: unknown): Promise<LargeViewInfo> {
    const origin = (payload as { origin?: unknown } | null | undefined)?.origin;
    parseOpenerOrigin(origin);
    // Serialise: two quick clicks must not start two listeners.
    const generation = this.generation;
    const run = (this.pending ?? Promise.resolve()).catch(() => undefined).then(() => this.ensure(origin as string, generation));
    this.pending = run;
    return run;
  }

  private async ensure(origin: string, generation: number): Promise<LargeViewInfo> {
    if (generation !== this.generation) throw new LargeViewError('the large view was closed');
    if (this.server?.running && this.started && this.server.openerOrigin === origin) {
      return { ...this.started, openerOrigin: origin };
    }
    await this.stopServer();
    const server = await LargeViewServer.create({ ...this.opts, openerOrigin: origin });
    const started = await server.start();
    if (generation !== this.generation) {
      // stop() ran while this start was in flight: never leave it listening.
      await server.stop();
      throw new LargeViewError('the large view was closed');
    }
    this.server = server;
    this.started = started;
    return { ...started, openerOrigin: origin };
  }

  /**
   * Handler of `/large-view/stop` and of the shutdown hooks. Also cancels a
   * start that is still in flight: when this resolves, nothing listens.
   */
  async stop(): Promise<{ stopped: boolean }> {
    this.generation++;
    const pending = this.pending;
    if (pending) await pending.catch(() => undefined);
    return { stopped: await this.stopServer() };
  }

  private async stopServer(): Promise<boolean> {
    const server = this.server;
    this.server = null;
    this.started = null;
    if (!server) return false;
    await server.stop();
    return true;
  }

  /**
   * Closes the listener when the dialog closes. plugin-ui-utils answers an
   * IPC disconnect with SIGTERM to itself; a SIGTERM listener replaces Node's
   * default exit, so this one exits once the listener is closed (or after
   * `graceMs`).
   */
  installShutdownHooks(proc: ShutdownProcess, exit: (code: number) => void, graceMs = 1000): void {
    let exiting = false;
    const shutdown = (): void => {
      if (exiting) return;
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

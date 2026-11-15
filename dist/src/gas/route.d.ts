import type { GasService } from './service.js';
/** Page size of /v1/gas/days. */
export declare const MAX_GAS_DAYS = 3700;
export interface RouteResult {
    status: number;
    body: unknown;
}
/** `/v1/gas/status`: never carries the host, the device address, credentials or the session id. */
export declare function gasStatus(gas: GasService, nowMs: number): Promise<Record<string, unknown>>;
/** The `/v1/gas/*` routes. GET and the token are checked by the server before this runs. */
export declare function handleGas(gas: GasService, url: URL, nowMs: number): Promise<RouteResult>;

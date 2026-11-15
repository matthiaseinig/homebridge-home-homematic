/**
 * TLS for the CCU's XML-RPC ports (42001 BidCos-RF, 42010 HmIP-RF, 42000
 * BidCos-Wired, 49292 VirtualDevices). A CCU serves a self-signed
 * certificate, so it is accepted only on request:
 *   - `fingerprint256` set: exactly that certificate is accepted (pinned),
 *     whoever signed it; any other certificate ends the connection before
 *     a byte of the request (and its Authorization header) is sent.
 *   - `allowSelfSigned` without a fingerprint: any certificate is accepted
 *     (encrypted, but not protected against a man in the middle).
 *   - neither: normal verification against the system CAs, which a
 *     self-signed CCU certificate fails.
 */
import { Agent } from 'node:https';
export interface CcuTlsOptions {
    allowSelfSigned: boolean;
    /** SHA-256 certificate fingerprint as `AA:BB:...` (see normalizeFingerprint). */
    fingerprint256?: string;
}
/** CCU XML-RPC ports over TLS. CUxD has none. */
export declare const TLS_INTERFACE_PORTS: {
    readonly 'BidCos-RF': 42001;
    readonly 'HmIP-RF': 42010;
    readonly 'BidCos-Wired': 42000;
    readonly VirtualDevices: 49292;
};
/**
 * Normalise a SHA-256 fingerprint (colons, spaces and case optional) to
 * Node's `fingerprint256` form `AA:BB:...`. Undefined when it is not 32
 * hex bytes.
 */
export declare function normalizeFingerprint(value: string): string | undefined;
/** The https.Agent for the CCU's TLS XML-RPC ports. */
export declare function ccuTlsAgent(opts: CcuTlsOptions): Agent;

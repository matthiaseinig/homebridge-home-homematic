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
import { connect } from 'node:tls';
/** CCU XML-RPC ports over TLS. CUxD has none. */
export const TLS_INTERFACE_PORTS = {
    'BidCos-RF': 42001,
    'HmIP-RF': 42010,
    'BidCos-Wired': 42000,
    'VirtualDevices': 49292,
};
/**
 * Normalise a SHA-256 fingerprint (colons, spaces and case optional) to
 * Node's `fingerprint256` form `AA:BB:...`. Undefined when it is not 32
 * hex bytes.
 */
export function normalizeFingerprint(value) {
    const hex = value.replace(/[\s:]/g, '').toUpperCase();
    if (!/^[0-9A-F]{64}$/.test(hex)) {
        return undefined;
    }
    return hex.match(/../g).join(':');
}
class PinnedAgent extends Agent {
    fingerprint256;
    constructor(fingerprint256) {
        super({ rejectUnauthorized: false });
        this.fingerprint256 = fingerprint256;
    }
    createConnection(options) {
        const socket = connect({ ...options, rejectUnauthorized: false });
        socket.once('secureConnect', () => {
            const actual = socket.getPeerCertificate().fingerprint256;
            if (actual !== this.fingerprint256) {
                socket.destroy(new Error('CCU TLS certificate does not match tlsCertFingerprint'));
            }
        });
        return socket;
    }
}
/** The https.Agent for the CCU's TLS XML-RPC ports. */
export function ccuTlsAgent(opts) {
    if (opts.fingerprint256) {
        return new PinnedAgent(opts.fingerprint256);
    }
    return new Agent({ rejectUnauthorized: !opts.allowSelfSigned });
}
//# sourceMappingURL=ccuTls.js.map
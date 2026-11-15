/**
 * True for a literal loopback, link-local or private (RFC 1918, unique local)
 * address. Wildcards (`0.0.0.0`, `::`), host names and public addresses are
 * not allowed.
 */
export declare function isPrivateAddress(address: string): boolean;

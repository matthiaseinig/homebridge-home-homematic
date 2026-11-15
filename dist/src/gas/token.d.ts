export declare const GAS_TOKEN_FILE = "gas-api-token";
/**
 * The bearer token of the gas API, kept in `path` (inside the Homebridge
 * storage folder, mode 0600). A missing or malformed file is replaced by a
 * new random token (32 bytes, base64url). The token is never logged; the
 * owner copies it from the file.
 */
export declare function loadOrCreateToken(path: string): Promise<{
    token: string;
    created: boolean;
}>;

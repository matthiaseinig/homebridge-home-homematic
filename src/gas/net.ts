import { isIP } from 'node:net';

/**
 * True for a literal loopback, link-local or private (RFC 1918, unique local)
 * address. Wildcards (`0.0.0.0`, `::`), host names and public addresses are
 * not allowed.
 */
export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const addr = mapped?.[1] ?? address;
  const family = isIP(addr);
  if (family === 4) {
    const [a = 0, b = 0] = addr.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  if (family === 6) {
    const lower = addr.toLowerCase();
    if (lower === '::1') return true;
    const first = parseInt(lower.split(':')[0] || '0', 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
  }
  return false;
}

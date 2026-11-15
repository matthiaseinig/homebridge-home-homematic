import type { ServiceDefinition } from '../types.js';
/**
 * Status (transmitter) channel of an HmIP virtual receiver: the first channel
 * of its group of four, n - ((n - 1) % 4). Undefined when the address has no
 * channel index, or the channel already is the first of its group.
 */
export declare function transmitterAddress(address: string): string | undefined;
export declare const blindService: ServiceDefinition;

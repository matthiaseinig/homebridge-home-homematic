import type { ServiceDefinition } from '../types.js';
import type { CcuChannel } from '../../types.js';
/**
 * Status (transmitter) channel of an HmIP virtual receiver, for layouts where
 * the transmitter is the first channel of a group of four (HmIPW-DRBL4,
 * DRBLI4, DRSI4: 1/5/9/13, each followed by three virtual receivers). It is
 * the nearest preceding BLIND_/SHUTTER_TRANSMITTER of the same device taken
 * from `channels`, and only when it is that group start. Other layouts (for
 * example HmIP-BROLL, FROLL, BBL, FBL with the transmitter on channel 3, whose
 * virtual receiver follows wall button moves) and unknown channel types give
 * undefined: the virtual channel is used, with no guess.
 */
export declare function transmitterAddress(address: string, channels: readonly CcuChannel[] | undefined): string | undefined;
export declare const blindService: ServiceDefinition;

/** True when `timeZone` is an IANA zone the runtime knows. */
export declare function isValidTimeZone(timeZone: string): boolean;
/** Local calendar day `YYYY-MM-DD` of an epoch millisecond value in `timeZone`. */
export declare function dayKey(epochMs: number, timeZone: string): string;
export declare const DAY_PATTERN: RegExp;
export declare const MONTH_PATTERN: RegExp;
/** Offset of `timeZone` from UTC at `epochMs`, in ms (positive east of Greenwich). */
export declare function utcOffsetMs(epochMs: number, timeZone: string): number;
/** Year, month (1 to 12) and day of a `YYYY-MM-DD` key (0 for a missing part). */
export declare function ymd(day: string): [number, number, number];
/** Epoch ms of local midnight that starts `day` (`YYYY-MM-DD`) in `timeZone`. */
export declare function dayStartMs(day: string, timeZone: string): number;
/** `YYYY-MM-DD` shifted by `delta` calendar days. */
export declare function addDays(day: string, delta: number): string;

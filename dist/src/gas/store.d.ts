/** Daily totals are kept this long. */
export declare const DAYS_RETENTION_YEARS = 10;
export declare const BUCKET_SECONDS = 300;
/** Start (epoch seconds) of the 5 minute bucket that contains `epochMs`. */
export declare function bucketStart(epochMs: number): number;
export declare const LIVE_PREFIX = "power-live-";
export declare const DAYS_PREFIX = "power-days-";
/** One 5 minute aggregate: bucket start (epoch s), mean W, max W, energy Wh in the bucket. */
export type Row = [t: number, avgW: number | null, maxW: number | null, wh: number];
/** Energy per series (`<deviceId>|<channel>`) of one local day, Wh. */
export type DayEnergy = Record<string, number>;
export interface BucketStoreOptions {
    dir: string;
    timeZone: string;
    retentionDays: number;
    now?: () => number;
    onWarn?: (message: string) => void;
    /** File name prefix of the 5 minute files (default `power-live-`). */
    livePrefix?: string;
    /** File name prefix of the month files with the daily totals (default `power-days-`). */
    daysPrefix?: string;
    /** What the files hold, for the warning about an unreadable file (default `power`). */
    label?: string;
}
export declare const seriesKey: (deviceId: string, channel: string) => string;
/**
 * Local history store. Samples are averaged into 5 minute rows (one file per
 * local day, `power-live-YYYY-MM-DD.json`, kept `retentionDays`) and their
 * energy is summed per local day (one file per month, `power-days-YYYY-MM.json`,
 * kept 10 years). Files are atomic, 0600; an unreadable file is moved aside.
 * The prefixes are options, so other counters (the gas meter: m³ instead of
 * Wh, m³/h instead of W) reuse the store in files of their own.
 */
export declare class BucketStore {
    private readonly opts;
    private readonly open;
    private readonly pendingRows;
    private readonly pendingEnergy;
    private writing;
    /** Newest sample time seen, epoch ms. */
    lastSample?: number;
    private readonly livePrefix;
    private readonly daysPrefix;
    constructor(opts: BucketStoreOptions);
    private now;
    private warnBackup;
    /** Add one sample. `powerW` may be missing; `deltaWh` is the energy since the previous sample. */
    record(key: string, tMs: number, powerW: number | undefined, deltaWh: number): void;
    private rowOf;
    private close;
    /** Persist closed buckets and day energy. `all` also closes the running bucket (shutdown). */
    flush(all?: boolean): Promise<void>;
    private liveFile;
    private daysFile;
    private readLiveFile;
    private writeLive;
    private readMonthFile;
    private writeMonth;
    private names;
    /** Rows of one device in `[fromSec, toSec]`, per channel, ascending; includes unflushed data. */
    readLive(deviceId: string, fromSec: number, toSec: number): Promise<Record<string, Row[]>>;
    /** Energy per day and series (Wh) for days in `[from, to]`, ascending; includes unflushed data. */
    readDays(from: string, to: string): Promise<Array<{
        date: string;
        energy: DayEnergy;
    }>>;
    /** Delete 5 minute files older than the retention and day files older than 10 years (with backups). */
    prune(nowMs: number): Promise<void>;
    get bucketSeconds(): number;
}

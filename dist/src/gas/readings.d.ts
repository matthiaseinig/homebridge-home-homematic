import type { MeterReading } from './config.js';
/** What the readings need from the gas history. */
export interface GasHistoryView {
    /** m³ per local day in `[from, to]` (days without consumption may be missing). */
    days(from: string, to: string): Promise<Map<string, number>>;
    /** 5 minute rows `[bucket start s, m³]` of a local day; empty when none are kept. */
    rows(day: string): Promise<Array<[number, number]>>;
}
export interface Recorded {
    m3: number;
    /** False when part of a day had to be split but its 5 minute rows are no longer kept. */
    exact: boolean;
}
export interface DriftEntry {
    date: string;
    time: string | null;
    m3: number;
    /** The previous reading plus the m³ recorded since it. */
    expectedM3: number;
    /** Reading minus expected: positive means the plugin recorded too little. */
    driftM3: number;
    exact: boolean;
}
/** Epoch ms of the local wall time `HH:MM` on `day` in `timeZone` (DST aware). */
export declare function localTimeMs(day: string, time: string, timeZone: string): number;
/** Readings taken up to `nowMs` (a reading without a time counts once its day has begun). */
export declare function applicableReadings(readings: readonly MeterReading[], nowMs: number, timeZone: string): MeterReading[];
/**
 * The displayed meter reading: the latest applicable reading plus what was
 * recorded after it until now. Undefined without an applicable reading (the
 * caller then shows the device counter).
 */
export declare function displayedReading(view: GasHistoryView, readings: readonly MeterReading[], nowMs: number, timeZone: string): Promise<{
    reading: MeterReading;
    m3: number;
    exact: boolean;
} | undefined>;
/** For every applicable reading after the first: how far it is from the previous one plus the recorded m³. */
export declare function readingDrift(view: GasHistoryView, readings: readonly MeterReading[], nowMs: number, timeZone: string): Promise<DriftEntry[]>;

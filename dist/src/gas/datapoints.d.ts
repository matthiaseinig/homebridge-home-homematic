import type { GasSettings } from './config.js';
export interface DatapointCheck {
    checked: boolean;
    /** Both configured datapoints exist on the channel. */
    found?: boolean;
    /** Units the CCU reports for the configured datapoints. */
    units?: {
        counter: string | null;
        flow: string | null;
    };
    /** Log lines for the owner. */
    messages?: string[];
}
/**
 * Datapoint names and units from an `Interface.getParamsetDescription`
 * result. The CCU answers with a list of descriptions (`NAME` or `ID`, `UNIT`)
 * or, on some versions, with an object keyed by name.
 */
export declare function describedDatapoints(raw: unknown): Map<string, string | null>;
/** Compare the description with the configured datapoint names. */
export declare function checkDatapoints(raw: unknown, settings: Pick<GasSettings, 'counterDatapoint' | 'flowDatapoint' | 'channel'>): DatapointCheck;

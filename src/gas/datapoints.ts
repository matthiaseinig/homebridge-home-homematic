import type { GasSettings } from './config.js';

export interface DatapointCheck {
  checked: boolean;
  /** Both configured datapoints exist on the channel. */
  found?: boolean;
  /** Units the CCU reports for the configured datapoints. */
  units?: { counter: string | null; flow: string | null };
  /** Log lines for the owner. */
  messages?: string[];
}

const NAME = /^[A-Z0-9_]{1,64}$/;
const MAX_LISTED = 30;

const text = (v: unknown): string | undefined =>
  typeof v === 'string' ? v.replace(/[^\x20-\x7e]/g, '').slice(0, 32) : undefined;

/**
 * Datapoint names and units from an `Interface.getParamsetDescription`
 * result. The CCU answers with a list of descriptions (`NAME` or `ID`, `UNIT`)
 * or, on some versions, with an object keyed by name.
 */
export function describedDatapoints(raw: unknown): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const add = (name: unknown, d: unknown): void => {
    const n = text(name);
    if (n === undefined || !NAME.test(n) || out.size >= 500) return;
    const unit =
      d !== null && typeof d === 'object' ? text((d as Record<string, unknown>).UNIT) : undefined;
    out.set(n, unit ?? null);
  };
  if (Array.isArray(raw)) {
    for (const d of raw) {
      if (d === null || typeof d !== 'object') continue;
      const o = d as Record<string, unknown>;
      add(o.NAME ?? o.ID ?? o.name, d);
    }
  } else if (raw !== null && typeof raw === 'object') {
    for (const [name, d] of Object.entries(raw as Record<string, unknown>)) add(name, d);
  }
  return out;
}

/** Compare the description with the configured datapoint names. */
export function checkDatapoints(
  raw: unknown,
  settings: Pick<GasSettings, 'counterDatapoint' | 'flowDatapoint' | 'channel'>,
): DatapointCheck {
  const dps = describedDatapoints(raw);
  const { counterDatapoint: counter, flowDatapoint: flow, channel } = settings;
  const units = { counter: dps.get(counter) ?? null, flow: dps.get(flow) ?? null };
  const missing = [counter, flow].filter((n) => !dps.has(n));
  if (missing.length === 0) {
    return {
      checked: true,
      found: true,
      units,
      messages: [
        `channel ${channel} has ${counter} (${units.counter ?? 'no unit'}) and ${flow} (${units.flow ?? 'no unit'}).`,
      ],
    };
  }
  const listed = [...dps.keys()].sort().slice(0, MAX_LISTED);
  const has = `${listed.length > 0 ? listed.join(', ') : 'no datapoints'}${dps.size > MAX_LISTED ? ', ...' : ''}`;
  return {
    checked: true,
    found: false,
    units,
    messages: [
      `channel ${channel} has no ${missing.join(' and ')}; it has ${has}. `
        + 'Set gas.datapoints (and gas.address) to the names of the gas counter and flow.',
    ],
  };
}

# Gas meter contract (HomeKit service and LAN API)

This document is the contract between this plugin and apps that read the gas meter, in particular the companion iOS app. It covers the HomeKit `Gas Meter` service and the LAN API `/v1/gas/*`. The HomeKit service is a convenience view; the LAN API is the authority for the full history and the figures.

The source of truth for the HomeKit definitions is [`src/gas/definitions.ts`](../src/gas/definitions.ts). The service and characteristic UUIDs are the same as in the energy plugin's contract (generated 2026-11-10), so an app that reads them keeps working unchanged. A unit test (`test/unit/gas/hap.test.ts`) fails when a UUID or a valid bit changes.

## The device and how it is read

The gas meter is a Homematic HM-ES-TX-WM ("Gaszähler", BidCos-RF) with the gas sensor. It is read through this plugin's **existing CCU session** (the JSON-RPC client of the platform block, same CCU user, same login); there is no second CCU client and no second set of credentials.

- **Read-only.** For this device the plugin sends only `Interface.getValue` and `Interface.getParamset` (paramset `VALUES`), plus `Interface.getParamsetDescription` (paramset `VALUES`) once at start. A fixed allow-list in [`src/gas/ccuReader.ts`](../src/gas/ccuReader.ts) refuses every other method; no setter, script, program or system variable call is ever sent for the gas meter. `Session.login` and `Session.logout` are sent by the shared session.
- **Polled, not event driven.** The gas meter does not use the XML-RPC event subscriptions. A firewalled event port (for example HmIP-RF) does not block it, and it starts before (and independently of) the event subscriptions.
- **Never mapped twice.** While `gas.enabled` is set, no channel mapping of the gas device is built as an accessory (whatever its service), and a `POWERMETER_IGL` channel mapped as `PowerMeterAccessory` is skipped with a warning instead of an Outlet. The log line does not carry the device address.

## Configuration (`gas` block of the platform)

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Turns the gas meter on. Without it nothing of the block is checked. |
| `name` | `Gas Meter` | HomeKit name (at most 64 characters). |
| `address` | required | Channel address of the gas sensor: `[<interface>.]<serial>[:<channel>]`, for example `BidCos-RF.<serial>:1`. Channel 0 of the same device gives `UNREACH` and `LOWBAT`. An invalid address turns the gas meter off. |
| `interface` | `BidCos-RF` | CCU interface, when `address` has no prefix. |
| `channel` | `1` | Channel (1 to 50), when `address` has no `:<channel>`. |
| `datapoints.counter` | `GAS_ENERGY_COUNTER` | The m³ counter of the channel. |
| `datapoints.flow` | `GAS_POWER` | The m³/h flow of the channel. |
| `pollInterval` | `60` | Seconds between polls, 30 to 600. |
| `timeZone` | this host | IANA time zone of the days. |
| `calorificValue` | `11.2` | kWh/m³, 8 to 13 (as on the gas bill). |
| `zNumber` | `0.95` | Zustandszahl, 0.8 to 1.0 (as on the gas bill). |
| `factorPeriods` | `[]` | Dated overrides: `from`, optional `to` (`YYYY-MM-DD`, inclusive), `calorificValue` and/or `zNumber`. Periods must not overlap. |
| `meterReadings` | `[]` | Readings of the mechanical meter: `date` (`YYYY-MM-DD`), optional `time` (`HH:MM` local), `m3`. |
| `bridge` | see below | `host`, or the name of an enabled multi-bridge. |
| `api.bindAddress` | off | Literal private or loopback IP address of this host for the LAN API (never `0.0.0.0`, never a host name). |
| `api.port` | `8766` | LAN API port, 1024 to 65535, not the event server port and not a bridge port. |

Invalid optional values fall back to their default (factors, time zone) or are ignored (periods, readings, API) with an error in the log; they never stop the rest of the plugin.

**Placement.** Without `gas.bridge` the accessory goes to the first enabled multi-bridge whose name contains "Keller", else to the plugin's own (host) child bridge. `gas.bridge: "host"` always uses the host bridge. A name that is not an enabled multi-bridge is an error: the accessory is then not published, while polling, history and the API still run. On a multi-bridge the accessory appears when that bridge is published (the multi-bridge rules apply: nothing is published before the CCU answered).

## HomeKit

| Accessory | How to recognise it | Custom service |
|---|---|---|
| Gas meter (one per platform block, only with `gas.enabled`) | `AccessoryInformation`: Manufacturer `HomeMatic HAP`, Model `Gas Meter`, SerialNumber `gas-meter` | one `Gas Meter` (`F7A10005-2128-484C-867A-5E08EB2F0F54`) |

The device address is never exposed. The accessory UUID is derived from the fixed seed `homebridge-homematic-hap:gas-meter`.

Every characteristic has the HAP permissions `pr` (paired read) and `ev` (notify); none is writable. Units are not encoded in the HAP metadata; take them from this table. Values are rounded to the listed resolution and clamped to the range.

**Missing values are never 0.** A value that is not known on the last poll is not written: the characteristic keeps its last value (or its initial `0` / `false`), and its bit in `Valid Fields` is cleared. An app must check the bit before it uses a value. Bit `n` (value `2^n`) is set when the characteristic with valid bit `n` was known on the last poll.

| Characteristic | UUID | Format | Unit | Range | Resolution | Valid bit | Source |
|---|---|---|---|---|---|---|---|
| Gas Flow (`GasFlow`) | `F7A000A0-2128-484C-867A-5E08EB2F0F54` | float | m³/h | 0 .. 1 000 | 0.001 | 0 | flow datapoint (`Interface.getParamset` `VALUES`); set only when the CCU answered and the device is reachable |
| Meter Reading (`GasMeterReading`) | `F7A000A1-2128-484C-867A-5E08EB2F0F54` | float | m³ | 0 .. 1 000 000 000 | 0.001 | 1 | without `gas.meterReadings`: the counter datapoint. With readings: the latest reading taken up to now plus the m³ recorded after it. Set only when the CCU answered and the device is reachable |
| Gas Today (`GasToday`) | `F7A000A2-2128-484C-867A-5E08EB2F0F54` | float | m³ | 0 .. 1 000 000 000 | 0.001 | 2 | sum of the counter steps recorded since local midnight; set once the day has a recorded sample |
| Gas Yesterday (`GasYesterday`) | `F7A000A3-2128-484C-867A-5E08EB2F0F54` | float | m³ | 0 .. 1 000 000 000 | 0.001 | 3 | sum of the counter steps of the previous local day; set when that day has samples or consumption |
| Gas Month (`GasMonth`) | `F7A000A4-2128-484C-867A-5E08EB2F0F54` | float | m³ | 0 .. 1 000 000 000 | 0.001 | 4 | sum of the recorded days of this calendar month including today |
| Gas Month kWh (`GasMonthKwh`) | `F7A000A5-2128-484C-867A-5E08EB2F0F54` | float | kWh | 0 .. 1 000 000 000 | 0.001 | 5 | sum over the same days of m³ of the day x factor of the day |
| Factor (`GasFactor`) | `F7A000A6-2128-484C-867A-5E08EB2F0F54` | float | kWh/m³ | 0 .. 100 | 0.0001 | 6 | calorific value x Zustandszahl that applies today |
| Reachable (`GasReachable`) | `F7A000A7-2128-484C-867A-5E08EB2F0F54` | bool | | true / false | | 7 | not `UNREACH` of channel 0 (`Interface.getValue`); set when the CCU answered |
| Low Battery (`GasLowBattery`) | `F7A000A8-2128-484C-867A-5E08EB2F0F54` | bool | | true / false | | 8 | `LOWBAT` of channel 0 (`Interface.getValue`); set when the CCU answered |
| Valid Fields (`ValidFields`) | `F7A00001-2128-484C-867A-5E08EB2F0F54` | uint32 | bit mask | 0 .. 4 294 967 295 | 1 | | bit set when the value was known on the last poll |
| Last Update (`LastUpdate`) | `F7A00002-2128-484C-867A-5E08EB2F0F54` | uint32 | s since 1970-01-01 UTC | 0 .. 4 294 967 295 | 1 | | plugin clock of the last poll in which the CCU answered and the device was reachable; unchanged otherwise |

The service also carries the standard `Name` characteristic.

## Polling, sessions and backoff

- Every `gas.pollInterval` seconds: `Interface.getValue` of `UNREACH` and `LOWBAT` on `<serial>:0` and `Interface.getParamset` (`VALUES`) of `<serial>:<channel>`.
- The shared session logs in once and is reused. A session error (`access denied`, which the CCU answers for an expired session and for missing rights) replaces the session once and retries, unless a later request on the same session succeeded; concurrent callers share that one login. When the fresh session is refused too, the method itself lacks the rights: the session is kept, only that call fails, and that method (per CCU interface) is not sent again for 10 minutes, doubling up to 1 hour, with one warning in the log; a success of the method ends its wait. A replaced session is logged out once no request uses it any more, and the live one when Homebridge shuts down. Writes are retried only on a real session error, never on a loose hint in an error text.
- **Backoff.** A rejected login, and a session that logs in fine but whose data call is refused again (usually missing rights, including the shared per-method wait above), count as a failure. The gas meter then waits one poll interval, then doubling waits up to 10 minutes, and sends nothing to the CCU meanwhile. Only a successful data call ends the backoff (a successful login alone does not). The backoff is kept in `gas-state.json` across restarts and dropped when the CCU host, user or password change.
- `Session.logout` is sent when Homebridge shuts down (the CCU client logs its session out on stop).
- **Error texts are masked.** The CCU host, the device address, the CCU user, the password, the session id and any IPv4 address are replaced by `***` in every CCU error text before it reaches the log or `/v1/gas/status`; texts are cut to 120 printable characters.

## Counter rules

- The counter datapoint is a monotonic m³ counter. The first sample only sets the baseline (also after a restart without a saved baseline).
- A step larger than 10 m³ per hour of elapsed time plus 0.05 m³ is implausible: it is dropped and the counter is re-based.
- A reading of exactly 0 while the baseline is above 0 is held: when the next reading is at or above the baseline, the 0 was a read glitch and counting continues from the baseline.
- **A value below the baseline is a reset only when it is below 1 m³** (the sensor restarted at 0, battery change or wrap); the new value is then the consumption since the restart. A lower value of 1 m³ or more is a read glitch: nothing is counted and the baseline is kept. This applies equally to the first reading after a restart of the plugin, which is compared with the saved baseline. When the counter stays at such a lower level (the same or rising) for 10 polls in a row, for example after a device replacement, it becomes the new baseline without counting anything.
- While `UNREACH` is true nothing is recorded, Gas Flow and Meter Reading are not set and the baseline is kept; the first reading after the device is back counts what was used meanwhile (within the plausibility limit).
- A step counts on the local day of the poll that saw it, in that poll's 5 minute bucket. Days are calendar days (23 and 25 hours on the daylight saving changes).

## History and kWh

- 5 minute rows (mean and max m³/h, m³) are kept 90 days; daily m³ are kept 10 years. Files live in the plugin's folder of the Homebridge storage path (`homebridge-homematic-hap/gas/`), written atomically with mode 0600; an unreadable file is moved aside, never overwritten.
- **kWh are computed when read, never stored:** m³ x calorific value x Zustandszahl of each day. Changing a factor or adding a `factorPeriods` entry changes the kWh of its days, never the m³.
- **Meter readings** only correct the displayed Meter Reading; past days are never rewritten. A reading without a time counts as taken at the end of its day. The difference between each reading and the reading before it plus what was recorded between them is reported as drift.

## LAN API

Off unless `gas.api.bindAddress` is set. The server binds to that one literal private or loopback address, refuses peers that are not private, accepts only `Host: <bindAddress>:<port>` (421 otherwise), serves GET only and requires `Authorization: Bearer <token>` on every route except `/v1/hello`.

The token is created at first start as 32 random bytes (base64url, 43 characters) in the file `homebridge-homematic-hap/gas-api-token` of the Homebridge storage path, mode 0600. The log names the file, never the token. Delete the file and restart to rotate it.

| Endpoint | Result |
|---|---|
| `GET /v1/hello?nonce=<43 base64url>` | no token: `204` with `X-Home-Proof: base64url_nopad(HMAC-SHA256(key = token, msg = "HOME-HELLO\n" + nonce + "\n" + host))`, 30 requests per minute per peer (429 above) |
| `GET /v1/gas/status` | `{schema: 1, reachable, lowBattery, lastUpdate, flowM3h, counterM3, meterReadingM3, meterReadingSource: "device" or "reading", reading: {date, time, m3} or null, drift: [{date, time, m3, expectedM3, driftM3, exact}], factor: {date, kwhPerM3, calorificValue, zNumber, source: "default" or "period"}, datapoints: {counter, flow, checked, found, units}, pollIntervalSeconds, intervalSeconds: 300, ccu: {session, lastError, retryAt}, units}`; unknown values are `null`, times are ISO strings; never carries the CCU host, the device address, credentials or the session id |
| `GET /v1/gas/live?date=YYYY-MM-DD` | `{date, intervalSeconds: 300, factor, columns: ["t", "avgM3h", "maxM3h", "m3"], rows: [[t, avgM3h, maxM3h, m3], ...]}` for the local day (`t` = bucket start in epoch seconds) |
| `GET /v1/gas/days?from=YYYY-MM-DD&to=YYYY-MM-DD` | `{days: [{period, m3, kwh, factor}], next}`: days with recorded consumption, at most 3700 per response; continue with `from=<next>` |
| `GET /v1/gas/months?from=YYYY-MM&to=YYYY-MM` | `{months: [{period, m3, kwh, factor, factors}]}` summed from the days |
| `GET /v1/gas/years?from=YYYY&to=YYYY` | `{years: [{period, m3, kwh, factor, factors}]}` summed from the days |

`from` and `to` are optional (unbounded) but must be real calendar dates in order, else 400. `factor` of a month or year is kWh / m³ of the period (the plain factor when m³ is 0) and `factors` lists every factor that applied to one of its days.

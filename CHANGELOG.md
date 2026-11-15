# Changelog

## 1.8.2

- **Gas meter: a sensor the CCU has not heard yet is "waiting", not "CCU not
  readable" (#16).** When the gas sensor is reachable (`UNREACH` 0) but the CCU
  has no value for its channel yet (no telegram since the CCU started,
  `RSSI_DEVICE` -65535), every read of the channel fails with `XML-RPC: general
  error`. The plugin logged that as "CCU not readable" on every start and
  marked the whole meter as failed. It now logs one info line, keeps the
  reachable and low battery state, shows no reading, and reads the counter as
  soon as the CCU has a value. Other errors are still reported as before.
- Every channel, variable and program accessory now sets its Accessory
  Information SerialNumber to its stable key (`<device address>:<channel>`,
  `var:<id>`, `prog:<name>`) instead of the Homebridge default serial. Accessory
  UUIDs and the hap-homematic identity transplant are unchanged. The gas meter
  keeps its serial `gas-meter`.

## 1.8.1

- **Blind status channel: only for wired actuator layouts.** The transmitter is
  now found from the device's channel types (the nearest preceding
  `BLIND_TRANSMITTER` or `SHUTTER_TRANSMITTER`) and used only when it is the
  first channel of a group of four (HmIPW-DRBL4, DRBLI4, DRSI4 style). Layouts
  such as HmIP-BROLL, FROLL, BBL and FBL (key channels 1-2, transmitter on
  channel 3, virtual receivers 4-6) keep the virtual channel, because their
  virtual receiver follows wall button moves. Unknown channel types also keep
  the virtual channel; there is no arithmetic guess and no warning.
- Fix a race after a HomeKit TargetPosition write: a stale "stable" report
  (`PROCESS` 0 or `ACTIVITY_STATE` 3) from the transmitter, with a `LEVEL`
  different from the new target, is ignored until a moving report arrives or
  about 5 s pass, so TargetPosition no longer jumps back to the old value.
- Slat tilt (`LEVEL_2`) uses one source at a time like position: the
  transmitter once it has answered, otherwise the virtual channel.
- The config UI server bundle is rebuilt from a clean `npm ci`.

## 1.8.0

- **Blinds: position and state now come from the status channel.** HmIP
  virtual receivers (`BLIND_VIRTUAL_RECEIVER`, `SHUTTER_VIRTUAL_RECEIVER`,
  for example HmIPW-DRBL4 channels 2-4, 6-8, 10-12, 14-16) only see moves made
  through themselves; a wall button or direct link changes just the
  transmitter channel of the group (the first of four, `n - ((n - 1) % 4)`,
  so 1, 5, 9, 13). CurrentPosition and PositionState now follow the
  transmitter's `LEVEL`, `ACTIVITY_STATE` and `PROCESS` (`LEVEL_2` for slats),
  and TargetPosition follows CurrentPosition when the blind stops after an
  external move. TargetPosition writes still go to the configured virtual
  channel, and the plugin sends no correction or other extra write.
- If the transmitter cannot be read, the blind falls back to the virtual
  channel as before, with one warning per accessory. The per-channel setting
  `useStatusChannel: false` turns the status channel off.

## 1.7.3

- **Gas meter: datapoint description failed on the CCU.** The CCU JSON API
  expects `paramsetKey` (not `paramsetType`) for
  `Interface.getParamsetDescription`; the call was rejected with "missing
  argument (paramsetKey)". Both paramset calls now send `paramsetKey`.
- **Gas meter: a transmitter that does not answer shows as unreachable.**
  When channel 0 reports `UNREACH`, the paramset is no longer requested
  (the CCU answers it with "XML-RPC: general error"), so the status reads
  "device not answering" instead of "CCU not readable". It is not an auth
  failure and adds no backoff beyond the normal poll.

## 1.7.2

- **Remote CCU without TLS used CCU-internal XML-RPC ports.** The CCU's
  `Interface.listInterfaces` returns only name, port and info (no url), so
  the loopback-URL filter never matched and a remote Homebridge subscribed
  on 32001/32010/39292. For a remote CCU the internal ports are now mapped
  to the external ones (31999 to 1999, 32000 to 2000, 32001 to 2001,
  32010 to 2010, 39292 to 9292).
- **Log hygiene.** Events of unmapped channels are logged at debug level
  only, and `IP_ADDRESS` values are never logged.
- `scripts/ccu-cert-fingerprint.mjs` prints only the fingerprint line;
  subject, issuer and expiry need `--verbose`.
- When the credentials are refused for TLS, the "Could not subscribe"
  warning appears once per start instead of once per interface.

## 1.7.1

- **XML-RPC event subscription on a CCU with authentication enabled.**
  With "Authentication" on (CCU Settings, Control panel, Security) every
  XML-RPC port answers HTTP 401, which the plugin only reported as
  `init failed: Invalid XML-RPC message`, so no bridge was ever published.
  The `ccuAuth` credentials are now also sent as HTTP Basic auth on the
  XML-RPC ports (init, getValue, setValue), and a non-XML-RPC answer is
  reported with the likely cause (401, `ccuAuth` missing or rejected).
  No Authorization header is sent when `ccuAuth` is off.
- **TLS XML-RPC.** With `useTls` the XML-RPC subscription uses the CCU's
  TLS ports (42001 BidCos-RF, 42010 HmIP-RF, 42000 BidCos-Wired, 49292
  VirtualDevices; `interfacePorts` overrides are used as TLS ports), and
  credentials never go over plain HTTP (CUxD has no TLS port and is reached
  without them). The JSON API over HTTPS follows the same rules (it used
  to accept any certificate). The CCU's self-signed certificate is
  accepted only with the new `tlsCertFingerprint` (pins exactly that
  certificate; a different one ends the connection before the request is
  sent) or `tlsAllowSelfSigned`; with `ccuAuth` and neither set, no
  credentials are sent and one error is logged. With `ccuAuth` and without
  `useTls`, one warning at start says the credentials cross the network
  readable. New `scripts/ccu-cert-fingerprint.mjs` (shipped in the
  package) prints the fingerprint with Node only.
- **External XML-RPC ports for a remote CCU.** `Interface.listInterfaces`
  on a CCU3 / RaspberryMatic reports CCU-internal loopback URLs
  (`127.0.0.1:32001`, `:32010`, `:39292/groups`), which only listen on the
  CCU itself; init on them timed out. Loopback URLs are now ignored for a
  remote CCU, so the external ports 2001 / 2010 / 9292 are used.
  `interfacePorts` still overrides both.
- **Backoff for the multi-bridge CCU retry loop.** The wait after a failed
  CCU connection attempt now doubles from `retrySeconds` up to 5 minutes
  (or `retrySeconds`, when that is longer) instead of a fixed 30 s, so a
  broken setup no longer hits the CCU twice a minute for hours. Every
  failed attempt logs its CCU session out (session handling from 1.7.0; a
  regression test now covers the retry loop end to end).

## 1.7.0

- **Read-only gas meter.** New `gas` block (off by default): an HM-ES-TX-WM
  with gas sensor is polled through the plugin's existing CCU session
  (`Interface.getValue` and `Interface.getParamset` `VALUES` only, an
  allow-list refuses everything else; no second CCU client). It is
  published as the `Gas Meter` service (`F7A10005`, characteristics
  `F7A000A0` to `F7A000A8` plus Valid Fields and Last Update, the same
  UUIDs as the app contract) on the multi-bridge whose name contains
  "Keller", else on the plugin's own bridge (`gas.bridge` chooses). History
  of its own (5 minute rows 90 days, daily m³ 10 years), kWh computed when
  read from dated factors, meter readings with drift, and an optional
  token-protected LAN API `/v1/gas/{status,live,days,months,years}` plus
  `/v1/hello`. Polling does not depend on the XML-RPC event ports. See
  docs/GAS-METER.md.
- **Gas device never mapped twice.** While the gas meter is on, a mapping of
  its device is skipped, and a `POWERMETER_IGL` channel mapped as power
  meter logs a warning instead of becoming an Outlet.
- **CCU session hygiene (all JSON-RPC calls).** `access denied` (how the CCU
  answers an expired session) now replaces the session once, shared by
  concurrent callers. A method refused again with the fresh session lacks
  the rights: the session is kept, only that call fails, and the method
  waits 10 minutes (doubling to 1 hour, one warning) before it is sent
  again; a success ends the wait. Replaced sessions are logged out once no
  request uses them, the live one when the plugin stops. Writes
  (`Interface.setValue`, `Program.execute`, ...) are retried only on a real
  session error. Session errors are detected on the raw CCU text; the
  password and session id are masked afterwards.
- **TLS agent option.** `CcuJsonRpcClient` accepts an optional `tlsAgent`
  for HTTPS (for example a pinned certificate); without it the behaviour is
  unchanged.
- **Gas backoff.** A rejected login, or a session that logs in but whose
  data call is refused, doubles the gas meter's wait (one poll interval up
  to 10 minutes, kept across restarts); only a successful data call ends it.
- **Masked gas errors.** The CCU host, the device address, the CCU user and
  any IPv4 address are masked in gas error texts in the log and in
  `/v1/gas/status`.
- **Counter restarts.** A drop below the baseline (also the saved one after
  a restart) is a sensor restart only when the new value is below 1 m³;
  otherwise it is a read glitch and nothing is counted.

## 1.6.0

- **Slat tilt on normal blinds.** A blind imported with `useSlats: true`
  keeps the normal blind type (live movement reporting) and now also gets
  CurrentHorizontalTiltAngle / TargetHorizontalTiltAngle, mapped to the
  HmIP `LEVEL_2` datapoint exactly like the slat blind type (shared code).
  Without `useSlats` nothing changes (tilt left on a cached accessory is
  removed).
- **Slat tilt writes that HmIP actuators accept.** A lone `LEVEL_2` is
  ignored by HmIP blind actuators, so tilt is debounced (about 1 s, last
  value wins) and written as one `COMBINED_PARAMETER` `L2=<pct>` (no `L=`:
  only the slats change, the blind never moves). Positions are unchanged
  from 1.5.0: plain `LEVEL`, at once. New plugin setting `slatWriteMode`:
  `combined` (default), `level2-then-stop` (opt-in; STOP only when the blind
  is not moving), `level2` (legacy). A failed tilt write is logged once per
  accessory, resets HomeKit's target tilt and is never replayed. Reported
  `LEVEL_2` above 1 is clamped for display only. Test one blind and switch
  the mode if needed (README).
- **Import converter hardening** (`--new-identities`): the ports of bridges
  kept from `--base` are reserved before new ports are assigned, so a kept
  bridge never moves; ports of other Homebridge child bridges are avoided
  (read from a full `config.json` passed as `--base`, or `--reserve-ports`);
  a bridge whose `--base` identity has to be discarded (old hap-homematic
  username, missing pin, username or port) prints a warning and is listed
  disabled unless `--keep-enabled`. If only the pin or `newIdentity` is
  missing, the username and port stay, only pin and setup id are renewed and
  the bridge is not disabled. `--base` also accepts the converter's own
  `--out` array and fails when no HomematicHap block is found. A kept
  bridge on the event server port, the host port or another bridge's port
  is warned about and does not move.

## 1.5.0

- **Import with new HomeKit identities.** `hap-homematic-to-config.mjs
  --new-identities` writes the multi-bridge block with a new identity per
  bridge (`newIdentity: true`, no transplanted UUIDs or persist files), so
  the new bridges can be paired while the hap-homematic bridges are still
  paired and running. Usernames and ports derive from the hap-homematic
  instance ids and never reuse a hap-homematic username; pins and setup ids
  are random, and bridges already in the `--base` block keep theirs.
  `--host-bridge-from-base` keeps the existing child bridge (`_bridge`).
- **Offline check for new identities.** `iid-check.mjs` now builds
  new-identity bridges too and reports their accessories and skipped
  mappings (before, they were not built at all).

- **Blinds report live movement.** Window coverings push every
  intermediate LEVEL as CurrentPosition, keep TargetPosition at the
  commanded value until the move ends, and report PositionState
  increasing/decreasing from WORKING/DIRECTION (classic BLIND) or
  ACTIVITY_STATE (HmIP), falling back to the direction of LEVEL changes
  and stopping when the level stops changing for 5 s. No accessory,
  service or characteristic ids change.

## 1.4.0

- **Multi-bridge mode.** One platform block can publish several HAP
  bridges itself (`multiBridge.bridges`), sharing one CCU connection and
  one event subscription. Each bridge keeps a transplanted hap-homematic
  identity: username, pin, setupID, bridge UUID (the hap-homematic
  instance id), accessory UUIDs and service subtypes. Meant to replace the
  hap-homematic add-on with one Homebridge child process instead of one
  per bridge.
  - Bridges are listed disabled; a disabled bridge is never built or
    published.
  - No bridge is published before the CCU answered (event subscription
    live, devices and needed variables listed); retries every
    `retrySeconds` (default 30).
  - A transplanted bridge is published only when its AccessoryInfo and
    IdentifierCache files exist in the persist directory and its pin and
    setupID match them; `newIdentity: true` allows a throwaway bridge.
  - Bridges whose port is taken or that have no buildable accessory are
    skipped; shutdown unpublishes (never deletes persist files).
  - Unused instance ids are no longer purged on these bridges, so a
    characteristic that appears after the first CCU read keeps its IID.
- Service handlers now depend on a small `AccessoryHandle` interface
  instead of Homebridge's `PlatformAccessory` (no behaviour change for
  platform accessories).
- `scripts/hap-homematic-to-config.mjs` writes one multi-bridge block by
  default (`--per-bridge-blocks` for the old layout), with `--enable`,
  `--smoke-bridge`, `--persist-bridge`.
- New `scripts/multi-bridge-enable.mjs`: enable or disable named bridges
  in a config file for a batch cutover (atomic write, keeps file mode).
- New `scripts/iid-check.mjs`: offline check that a block reuses every
  AID and IID from the bridges' IdentifierCaches.

## 1.3.0

- Migration-ready import of real hap-homematic backups: identity mode
  (`hapHomematicIdentity`, `uuidSeed`, hap-homematic service subtypes),
  Homematic IP thermostats, door openers that switch off again,
  key-press switches, per-block event ports and callback ids, and the CLI
  `scripts/hap-homematic-to-config.mjs`.

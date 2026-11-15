# Changelog

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

/**
 * Pure model of the large view channel table: rows from a snapshot, the
 * default for a channel that is switched on, and the operations an Apply
 * sends to the dialog (large-view-host.js checks and applies them).
 */

/** Services that support a CCU channel type (all services when none does). */
export function candidateServices(services, channelType) {
  const match = services.filter((s) => (s.channelTypes ?? []).includes(channelType));
  return match.length ? match : services;
}

function effectiveName(entry, channel) {
  if (typeof entry?.name === 'string' && entry.name.length) return entry.name;
  if (typeof entry?.settings?.name === 'string' && entry.settings.name.length) return entry.settings.name;
  return channel?.name || entry?.address || '';
}

/**
 * One row per discovered channel, plus configured channels the CCU did not
 * list (or when discovery has not run). `base` is the configured state.
 */
export function buildRows(snapshot) {
  const configured = new Map();
  (snapshot.blocks ?? []).forEach((b, bridgeIndex) => {
    for (const c of b.channels ?? []) configured.set(c.address, { entry: c, bridgeIndex });
  });
  const rows = [];
  const seen = new Set();
  for (const d of snapshot.devices ?? []) {
    for (const ch of d.channels ?? []) {
      seen.add(ch.address);
      rows.push(makeRow(ch.address, d, ch, configured.get(ch.address)));
    }
  }
  for (const [address, conf] of configured) {
    if (!seen.has(address)) rows.push(makeRow(address, null, null, conf));
  }
  // Device name order; channels without a discovered device last.
  return rows.sort((a, b) => (Number(!a.deviceName) - Number(!b.deviceName))
    || a.deviceName.localeCompare(b.deviceName, 'de')
    || a.address.localeCompare(b.address, 'de', { numeric: true }));
}

function makeRow(address, device, channel, conf) {
  const entry = conf?.entry;
  return {
    address,
    deviceName: device?.name ?? '',
    deviceType: device?.type ?? '',
    channelName: channel?.name ?? '',
    channelType: channel?.type ?? '',
    discovered: !!channel,
    base: entry
      ? { inHK: true, name: effectiveName(entry, channel), service: entry.service, subtype: entry.subtype ?? '', bridgeIndex: conf.bridgeIndex }
      : { inHK: false, name: channel?.name || address, service: '', subtype: '', bridgeIndex: 0 },
  };
}

/** The state a channel gets when it is switched on in the table. */
export function enabledDefaults(row, services) {
  if (row.base.inHK) return { ...row.base };
  const svc = candidateServices(services, row.channelType)[0];
  return {
    inHK: true,
    name: row.base.name,
    service: svc?.key ?? '',
    subtype: svc?.variants?.[0]?.id ?? '',
    bridgeIndex: 0,
  };
}

/** Variant to use after the service changed: keep it when still valid. */
export function variantFor(services, serviceKey, current) {
  const variants = services.find((s) => s.key === serviceKey)?.variants ?? [];
  if (!variants.length) return '';
  return variants.some((v) => v.id === current) ? current : variants[0].id;
}

export function isChanged(base, cur) {
  if (base.inHK !== cur.inHK) return true;
  if (!cur.inHK) return false;
  return base.name !== cur.name || base.service !== cur.service
    || (base.subtype || '') !== (cur.subtype || '') || base.bridgeIndex !== cur.bridgeIndex;
}

/** Operations for every row whose draft differs from the configured state. */
export function computeOps(rows, drafts) {
  const ops = [];
  for (const row of rows) {
    const cur = drafts.get(row.address);
    if (!cur || !isChanged(row.base, cur)) continue;
    if (!cur.inHK) {
      ops.push({ op: 'remove', address: row.address });
    } else {
      ops.push({
        op: 'set',
        address: row.address,
        name: cur.name.trim(),
        service: cur.service,
        ...(cur.subtype ? { subtype: cur.subtype } : {}),
        bridgeIndex: cur.bridgeIndex,
      });
    }
  }
  return ops;
}

export function matchesSearch(row, cur, services, query) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const svc = services.find((s) => s.key === cur.service)?.description ?? '';
  return [cur.name, row.deviceName, row.deviceType, row.channelName, row.address, row.channelType, cur.service, svc]
    .filter(Boolean).join(' ').toLowerCase().includes(q);
}

export function matchesFilter(row, cur, filter) {
  switch (filter) {
    case 'hk': return cur.inHK;
    case 'nohk': return !cur.inHK;
    case 'changed': return isChanged(row.base, cur);
    default: return true;
  }
}

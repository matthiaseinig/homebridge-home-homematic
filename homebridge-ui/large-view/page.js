/**
 * Large view page (issue Home#614). Talks only to the Homebridge dialog
 * that opened it (window.opener, checked origin). It never sees ccuAuth or
 * other secrets and cannot write anything itself: "Übernehmen" sends channel
 * operations to the dialog, which checks them and stages them; the owner
 * then presses Save in the dialog.
 */

import { createPageLink } from '/kit/link.js';
import {
  buildRows, candidateServices, computeOps, enabledDefaults, isChanged, matchesFilter, matchesSearch, variantFor,
} from '/table-model.js';

const $ = (id) => document.getElementById(id);
const h = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

const view = {
  snapshot: null,
  rows: [],
  byAddress: new Map(),
  drafts: new Map(),
  busy: false,
  discovering: false,
  connected: false,
  closed: false,
};

const openerOrigin = document.querySelector('meta[name="hm-opener-origin"]')?.content ?? '';

// ---------------------------------------------------------------- status

function setStatus(text, kind = 'info') {
  const el = $('status');
  el.textContent = text;
  el.className = `status ${text ? kind : ''}`;
}

function setLinkState(text, kind) {
  const el = $('link-state');
  el.textContent = text;
  el.className = `pill ${kind}`;
}

// ---------------------------------------------------------------- state helpers

const services = () => view.snapshot?.services ?? [];
const current = (row) => view.drafts.get(row.address) ?? row.base;

function setDraft(row, next) {
  if (isChanged(row.base, next)) view.drafts.set(row.address, next);
  else view.drafts.delete(row.address);
}

function pendingOps() {
  return computeOps(view.rows, view.drafts);
}

// ---------------------------------------------------------------- rendering

function serviceOptions(row, cur) {
  const list = candidateServices(services(), row.channelType);
  const keys = new Set(list.map((s) => s.key));
  const all = cur.service && !keys.has(cur.service)
    ? [...list, ...services().filter((s) => s.key === cur.service)]
    : list;
  return all.map((s) => `<option value="${h(s.key)}" ${s.key === cur.service ? 'selected' : ''}>${h(s.description || s.key)}</option>`).join('');
}

function variantCell(cur, disabled) {
  const variants = services().find((s) => s.key === cur.service)?.variants ?? [];
  if (!variants.length) return '<span class="muted">-</span>';
  const standard = cur.subtype ? '' : '<option value="" selected>Standard</option>';
  return `<select data-f="subtype" ${disabled}>${standard}${variants.map((v) =>
    `<option value="${h(v.id)}" ${v.id === cur.subtype ? 'selected' : ''}>${h(v.label)}</option>`).join('')}</select>`;
}

function bridgeOptions(cur) {
  return (view.snapshot?.blocks ?? []).map((b, i) =>
    `<option value="${i}" ${i === cur.bridgeIndex ? 'selected' : ''}>${h(b.name)}${i === 0 ? ' (Haupt)' : ''}</option>`).join('');
}

function rowHTML(row) {
  const cur = current(row);
  const off = cur.inHK ? '' : 'disabled';
  const cls = [cur.inHK ? '' : 'off', isChanged(row.base, cur) ? 'changed' : '', row.discovered ? '' : 'undiscovered'].join(' ');
  return `
    <tr data-address="${h(row.address)}" class="${cls}">
      <td class="c-hk"><input type="checkbox" data-f="inHK" ${cur.inHK ? 'checked' : ''} aria-label="In HomeKit"></td>
      <td><input type="text" data-f="name" value="${h(cur.name)}" maxlength="128" ${off} aria-label="Name in HomeKit"></td>
      <td>${h(row.deviceName)}${row.deviceType ? `<div class="muted small">${h(row.deviceType)}</div>` : ''}</td>
      <td>${row.discovered ? h(row.channelName) : '<span class="muted">nicht in der CCU gefunden</span>'}</td>
      <td><code>${h(row.address)}</code></td>
      <td class="small">${h(row.channelType)}</td>
      <td><select data-f="service" ${off}>${serviceOptions(row, cur)}</select></td>
      <td>${variantCell(cur, off)}</td>
      <td><select data-f="bridgeIndex" ${off}>${bridgeOptions(cur)}</select></td>
    </tr>`;
}

function visibleRows() {
  const q = $('search').value;
  const filter = $('filter').value;
  return view.rows.filter((r) => {
    const cur = current(r);
    return matchesFilter(r, cur, filter) && matchesSearch(r, cur, services(), q);
  });
}

function renderRows() {
  const rows = visibleRows();
  $('rows').innerHTML = rows.map(rowHTML).join('');
  $('empty').hidden = rows.length > 0;
  const inHK = view.rows.filter((r) => current(r).inHK).length;
  $('counts').textContent = `${rows.length} von ${view.rows.length} Kanälen, ${inHK} in HomeKit`;
  renderPending();
}

function replaceRow(row) {
  const tr = $('rows').querySelector(`tr[data-address="${CSS.escape(row.address)}"]`);
  if (tr) tr.outerHTML = rowHTML(row);
  renderPending();
}

function renderPending() {
  const n = pendingOps().length;
  $('pending').textContent = n ? `${n} ${n === 1 ? 'Änderung' : 'Änderungen'}` : '';
  const canWrite = view.connected && !view.closed && !view.busy;
  $('apply').disabled = !n || !canWrite;
  $('discard').disabled = !n || view.busy;
  $('discover').disabled = !canWrite;
  const tr = $('rows').querySelectorAll('tr');
  for (const el of tr) {
    const row = view.byAddress.get(el.dataset.address);
    if (row) el.classList.toggle('changed', isChanged(row.base, current(row)));
  }
}

// ---------------------------------------------------------------- snapshot

function loadSnapshot(snap) {
  const first = !view.snapshot;
  view.snapshot = snap;
  view.rows = buildRows(snap);
  view.byAddress = new Map(view.rows.map((r) => [r.address, r]));
  // Keep drafts that still differ from the (new) configured state.
  for (const [address, cur] of [...view.drafts]) {
    const row = view.byAddress.get(address);
    if (!row || !isChanged(row.base, cur)) view.drafts.delete(address);
  }
  $('version').textContent = snap.pluginVersion ? `v${snap.pluginVersion}` : '';
  renderRows();
  if (first && !snap.devices?.length) setStatus('Keine CCU-Daten geladen: es werden nur die konfigurierten Kanäle angezeigt. "CCU einlesen" lädt alle Kanäle.', 'warn');
}

// ---------------------------------------------------------------- events

function onRowEvent(e) {
  const el = e.target;
  const f = el.dataset?.f;
  const tr = el.closest('tr[data-address]');
  if (!f || !tr) return;
  const row = view.byAddress.get(tr.dataset.address);
  if (!row) return;
  const cur = { ...current(row) };
  if (f === 'inHK') {
    const next = el.checked ? (row.base.inHK ? { ...row.base } : enabledDefaults(row, services())) : { ...cur, inHK: false };
    setDraft(row, next);
    replaceRow(row);
    return;
  }
  if (f === 'name') {
    cur.name = el.value;
    setDraft(row, cur);
    renderPending();
    return;
  }
  if (f === 'service') {
    cur.service = el.value;
    cur.subtype = variantFor(services(), cur.service, cur.subtype);
    setDraft(row, cur);
    replaceRow(row);
    return;
  }
  if (f === 'subtype') cur.subtype = el.value;
  if (f === 'bridgeIndex') cur.bridgeIndex = parseInt(el.value, 10);
  setDraft(row, cur);
  renderPending();
}

function onMessage(msg) {
  switch (msg.type) {
    case 'snapshot':
      view.connected = true;
      setLinkState('Verbunden mit dem Homebridge-Dialog', 'ok');
      loadSnapshot(msg);
      if (view.discovering) {
        view.discovering = false;
        view.busy = false;
        setStatus(`CCU eingelesen: ${msg.devices?.length ?? 0} Geräte.`, 'ok');
        renderPending();
      }
      break;
    case 'applied':
      view.busy = false;
      if (msg.ok) {
        view.drafts.clear();
        setStatus(`${msg.count} ${msg.count === 1 ? 'Änderung' : 'Änderungen'} übernommen. Jetzt im Homebridge-Dialog auf "Speichern" klicken, damit sie geschrieben werden.`, 'ok');
      } else if (msg.code === 'stale') {
        setStatus('Die Konfiguration im Dialog hat sich inzwischen geändert. Die Tabelle wurde neu geladen; bitte die markierten Änderungen prüfen und erneut übernehmen.', 'warn');
      } else {
        setStatus(`Nicht übernommen: ${msg.error ?? 'unbekannter Fehler'}`, 'error');
      }
      renderPending();
      break;
    case 'error':
      view.busy = false;
      view.discovering = false;
      setStatus(`Fehler: ${msg.error ?? 'unbekannt'}`, 'error');
      renderPending();
      break;
    default:
      break;
  }
}

function start() {
  const link = openerOrigin ? createPageLink({ win: window, openerOrigin, onMessage }) : null;
  if (!link) {
    setLinkState('Nicht verbunden', 'error');
    setStatus('Diese Seite funktioniert nur, wenn sie im Homebridge-Dialog über "Open large view" geöffnet wird.', 'error');
    renderPending();
    return;
  }

  $('rows').addEventListener('change', onRowEvent);
  $('rows').addEventListener('input', (e) => { if (e.target.dataset?.f === 'name') onRowEvent(e); });
  $('search').addEventListener('input', renderRows);
  $('filter').addEventListener('change', renderRows);
  $('discard').addEventListener('click', () => { view.drafts.clear(); setStatus(''); renderRows(); });
  $('discover').addEventListener('click', () => {
    view.busy = true;
    view.discovering = true;
    setStatus('CCU wird eingelesen…');
    renderPending();
    link.send('discover');
  });
  $('apply').addEventListener('click', () => {
    const ops = pendingOps();
    const bad = ops.find((o) => o.op === 'set' && !o.name);
    if (bad) { setStatus(`${bad.address}: Name darf nicht leer sein.`, 'error'); return; }
    view.busy = true;
    setStatus('Wird übernommen…');
    renderPending();
    link.send('apply', { revision: view.snapshot?.revision, ops });
  });
  window.addEventListener('beforeunload', (e) => {
    if (pendingOps().length) e.preventDefault();
  });

  setInterval(() => {
    if (!view.closed && link.openerClosed()) {
      view.closed = true;
      setLinkState('Dialog geschlossen', 'error');
      setStatus('Der Homebridge-Dialog wurde geschlossen. Änderungen können nicht mehr übernommen werden; dieses Fenster kann geschlossen werden.', 'error');
      renderPending();
    }
  }, 1000);

  setTimeout(() => {
    if (!view.connected) {
      setLinkState('Keine Antwort', 'error');
      setStatus('Der Homebridge-Dialog antwortet nicht. Bitte das Fenster schließen und im Dialog erneut "Open large view" wählen.', 'error');
    }
  }, 5000);

  link.send('hello');
}

start();

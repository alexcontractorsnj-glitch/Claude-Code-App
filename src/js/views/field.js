// ============================================================================
//  field.js (view) — Daily field reports log. Newest first, one card per day,
//  with weather, manpower, work performed, deliveries and delays.
// ============================================================================
import { store, Dates } from '../data.js';
import { reportsFor } from '../fieldreports.js';
import { el, clear } from '../utils.js';

const WEATHER_ICON = { Clear: '☀', 'Partly Cloudy': '⛅', Cloudy: '☁', Rain: '🌧', Storm: '⛈', Snow: '❄', Windy: '🌬', Fog: '🌫' };

export function renderField(mount, ctx) {
  clear(mount);
  const view = el('div', { class: 'cost-view' });
  const reports = reportsFor(store.reports, ctx.projectId);

  view.appendChild(el('div', { class: 'bill-controls' }, [
    el('div', { class: 'bill-title' }, `Daily Field Reports${ctx.projectId === 'all' ? ' — all projects' : ''}`),
    store.can('write') ? el('button', { class: 'btn primary sm', onclick: () => ctx.openReport(null) }, '+ New Report') : null,
  ]));

  if (!reports.length) {
    view.appendChild(el('div', { class: 'empty' }, 'No field reports yet.'));
    mount.appendChild(view); return;
  }

  const list = el('div', { class: 'field-list' });
  reports.forEach((r) => {
    const proj = store.project(r.projectId);
    const temp = (r.tempLow != null || r.tempHigh != null) ? ` · ${r.tempLow ?? '?'}–${r.tempHigh ?? '?'}°` : '';
    list.appendChild(el('div', { class: 'field-card', onclick: () => ctx.openReport(r.id) }, [
      el('div', { class: 'field-head' }, [
        el('div', { class: 'field-date' }, Dates.fmtLong(r.date)),
        ctx.projectId === 'all' && proj ? el('span', { class: 'field-proj', style: { color: proj.color } }, proj.name) : null,
        el('div', { class: 'field-wx' }, `${WEATHER_ICON[r.weather] || ''} ${r.weather}${temp}`),
        el('div', { class: 'field-crew' }, `👷 ${r.manpower}`),
      ]),
      r.workPerformed ? el('div', { class: 'field-row' }, [el('span', { class: 'field-k' }, 'Work'), el('span', {}, r.workPerformed)]) : null,
      r.deliveries ? el('div', { class: 'field-row' }, [el('span', { class: 'field-k' }, 'Deliveries'), el('span', {}, r.deliveries)]) : null,
      r.delays ? el('div', { class: 'field-row warn' }, [el('span', { class: 'field-k' }, 'Delays'), el('span', {}, r.delays)]) : null,
      el('div', { class: 'field-by' }, `— ${r.createdBy || 'Unknown'}`),
    ]));
  });
  view.appendChild(list);
  mount.appendChild(view);
}

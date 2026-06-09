// ============================================================================
//  fieldreports.js — Daily field reports (pure). The site's daily log: weather,
//  manpower, work performed, deliveries, delays. Linked to a project.
// ============================================================================
import { Dates } from './seed.js';
import { cleanAttachments } from './punch.js';

export const WEATHER = ['Clear', 'Partly Cloudy', 'Cloudy', 'Rain', 'Storm', 'Snow', 'Windy', 'Fog'];

export function makeReport(existing, partial) {
  const maxId = Math.max(0, ...(existing || []).map((r) => +String(r.id).slice(2) || 0));
  return {
    id: 'fr' + (maxId + 1),
    projectId: partial.projectId,
    date: partial.date || Dates.today(),
    weather: WEATHER.includes(partial.weather) ? partial.weather : 'Clear',
    tempLow: partial.tempLow === '' || partial.tempLow == null ? null : Number(partial.tempLow),
    tempHigh: partial.tempHigh === '' || partial.tempHigh == null ? null : Number(partial.tempHigh),
    manpower: Number(partial.manpower) || 0,
    workPerformed: partial.workPerformed || '',
    deliveries: partial.deliveries || '',
    delays: partial.delays || '',
    notes: partial.notes || '',
    attachments: cleanAttachments(partial.attachments, partial.createdBy),
    createdBy: partial.createdBy || null,
    createdAt: partial.createdAt || new Date().toISOString(),
    rev: 1,
  };
}

// Reports for a project (or all), newest date first.
export function reportsFor(reports, projectId) {
  return (reports || [])
    .filter((r) => projectId === 'all' || r.projectId === projectId)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

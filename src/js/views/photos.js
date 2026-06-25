// ============================================================================
//  photos.js (view) — Project Photos gallery. Aggregates every photo posted on
//  a task's Activity (or in chat) into one grid — the "dual surfacing" pattern
//  (a photo lives on its task AND shows up here), scoped by the project filter.
// ============================================================================
import { store, Dates } from '../data.js';
import { el, clear } from '../utils.js';

export function renderPhotos(mount, ctx) {
  clear(mount);
  const view = el('div', { class: 'cost-view' });
  const pics = store.photosFor(ctx.projectId);
  view.appendChild(el('div', { class: 'bill-controls' }, [
    el('div', { class: 'bill-title' }, `Photos${ctx.projectId === 'all' ? ' — all projects' : ''} · ${pics.length}`),
  ]));
  if (!pics.length) {
    view.appendChild(el('div', { class: 'empty' }, 'No photos yet — snap one from a task’s Activity tab.'));
    mount.appendChild(view); return;
  }
  const grid = el('div', { class: 'photo-grid' });
  pics.forEach((m) => {
    const task = (m.linkedTo && m.linkedTo.kind === 'task') ? store.task(m.linkedTo.id) : null;
    const proj = store.project((store.channel(m.channelId) || {}).projectId);
    grid.appendChild(el('div', { class: 'photo-cell' }, [
      el('img', { class: 'photo-thumb', src: store.photoSrc(m), loading: 'lazy', onclick: () => window.open(store.photoSrc(m), '_blank') }),
      el('div', { class: 'photo-cap' }, [
        el('div', { class: 'photo-by' }, `${m.authorName} · ${Dates.fmt(Dates.iso(new Date(m.createdAt)))}`),
        task ? el('div', { class: 'photo-task', onclick: () => ctx.openTask(task.id) }, '↳ ' + task.name)
          : (proj ? el('div', { class: 'photo-task muted' }, proj.name) : null),
      ]),
    ]));
  });
  view.appendChild(grid);
  mount.appendChild(view);
}

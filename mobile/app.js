// ============================================================================
//  app.js — Corefield mobile UI controller.
//  A phone-first, installable companion to BuildFlow for crews in the field:
//  My Work (tap to bump % / status), Punch list, and Daily Reports — all over
//  the same REST API, with offline-tolerant writes. Bottom-tab navigation,
//  big touch targets, no framework (matches the BuildFlow house style).
// ============================================================================

import { store, TRADES, STATUSES, Dates } from './store.js';
import {
  bucketTasks, stepProgress, coerceStatus, dueLabel, initials, PROGRESS_STEP,
} from '../src/mobile/core.js';
import { el, clear } from '../src/js/utils.js';
import { PUNCH_STATUSES, PUNCH_PRIORITIES } from '../src/js/punch.js';
import { WEATHER } from '../src/js/fieldreports.js';
import { startRecording, startDictation, supportsRecording, supportsDictation, fmtDur } from '../src/js/voice.js';

const TABS = {
  work:    { label: 'Work',    icon: '🪧' },
  chat:    { label: 'Chat',    icon: '💬' },
  punch:   { label: 'Punch',   icon: '✔' },
  reports: { label: 'Reports', icon: '📋' },
  me:      { label: 'Me',      icon: '👷' },
};
const STATUS_LABEL = { open: 'Open', ready: 'Ready', accepted: 'Accepted', rejected: 'Rejected' };

const ui = { tab: 'work' };
let root, built = false;

// --- helpers ----------------------------------------------------------------
const tradeName = (t) => (TRADES[t] ? TRADES[t].label : t || '—');
const tradeColor = (t) => (TRADES[t] ? TRADES[t].color : '#888');
const statusInfo = (s) => STATUSES[s] || { label: s, color: '#888' };

function ring(pct, size = 56) {
  const r = (size - 8) / 2, c = 2 * Math.PI * r, off = c * (1 - pct / 100);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`); svg.setAttribute('class', 'ring'); svg.style.width = size + 'px'; svg.style.height = size + 'px';
  const mk = (cls, dash) => {
    const ci = document.createElementNS(ns, 'circle');
    ci.setAttribute('cx', size / 2); ci.setAttribute('cy', size / 2); ci.setAttribute('r', r);
    ci.setAttribute('fill', 'none'); ci.setAttribute('stroke-width', '6'); ci.setAttribute('class', cls);
    if (dash != null) { ci.setAttribute('stroke-dasharray', c); ci.setAttribute('stroke-dashoffset', dash); ci.setAttribute('transform', `rotate(-90 ${size / 2} ${size / 2})`); ci.setAttribute('stroke-linecap', 'round'); }
    return ci;
  };
  svg.appendChild(mk('ring-bg'));
  svg.appendChild(mk('ring-fg', off));
  const t = document.createElementNS(ns, 'text');
  t.setAttribute('x', '50%'); t.setAttribute('y', '52%'); t.setAttribute('text-anchor', 'middle'); t.setAttribute('dominant-baseline', 'middle'); t.setAttribute('class', 'ring-text');
  t.textContent = Math.round(pct) + '%';
  svg.appendChild(t);
  return svg;
}

// --- bottom sheet -----------------------------------------------------------
function openSheet(title, buildBody) {
  closeSheet();
  const body = el('div', { class: 'sheet-body' });
  const sheet = el('div', { class: 'sheet' }, [
    el('div', { class: 'sheet-grab' }),
    el('div', { class: 'sheet-head' }, [
      el('div', { class: 'sheet-title' }, title),
      el('button', { class: 'sheet-x', onclick: closeSheet, 'aria-label': 'Close' }, '✕'),
    ]),
    body,
  ]);
  const back = el('div', { class: 'sheet-backdrop', onclick: (e) => { if (e.target === back) closeSheet(); } }, sheet);
  root.appendChild(back);
  buildBody(body, closeSheet);
  requestAnimationFrame(() => back.classList.add('show'));
}
function closeSheet() {
  const b = root && root.querySelector('.sheet-backdrop');
  if (!b) return;
  b.classList.remove('show');
  setTimeout(() => b.remove(), 220);
}

// --- app bar ----------------------------------------------------------------
function renderBar() {
  const bar = document.getElementById('cf-bar');
  if (!bar) return;
  clear(bar);
  const projects = store.projects;
  const sel = el('select', { class: 'cf-proj', onchange: (e) => store.setProject(e.target.value) }, [
    el('option', { value: 'all', selected: store.projectId === 'all' }, 'All projects'),
    ...projects.map((p) => el('option', { value: p.id, selected: store.projectId === p.id }, p.name)),
  ]);
  const pending = store.pendingCount();
  const pill = store.local
    ? el('span', { class: 'cf-pill demo' }, 'Demo')
    : store.online
      ? el('span', { class: 'cf-pill online' }, pending ? `Syncing ${pending}…` : 'Online')
      : el('span', { class: 'cf-pill offline' }, pending ? `Offline · ${pending} queued` : 'Offline');
  bar.append(
    el('div', { class: 'cf-brand' }, [
      el('span', { class: 'cf-mark' }, '◭'),
      el('div', {}, [el('div', { class: 'cf-name' }, 'Corefield'), el('div', { class: 'cf-sub' }, 'BuildFlow · Field')]),
    ]),
    el('div', { class: 'cf-bar-right' }, [sel, pill]),
  );
}

// --- tab bar ----------------------------------------------------------------
function renderTabBar() {
  const tb = document.getElementById('cf-tabs');
  if (!tb) return;
  clear(tb);
  const s = store.summary();
  const badge = { work: s.overdue, chat: store.totalUnread(), punch: store.punch().filter((p) => p.status === 'open').length, reports: 0, me: store.pendingCount() };
  Object.entries(TABS).forEach(([key, t]) => {
    const b = badge[key];
    tb.appendChild(el('button', {
      class: 'cf-tab' + (ui.tab === key ? ' active' : ''),
      onclick: () => { ui.tab = key; render(); },
    }, [
      el('span', { class: 'cf-tab-ico' }, t.icon),
      el('span', { class: 'cf-tab-lbl' }, t.label),
      b ? el('span', { class: 'cf-badge' }, String(b)) : null,
    ]));
  });
}

// --- WORK tab ---------------------------------------------------------------
function renderWork(main) {
  const tasks = store.tasks();
  const s = store.summary();
  const buckets = bucketTasks(tasks);

  main.appendChild(el('div', { class: 'cf-hero' }, [
    ring(s.progress, 64),
    el('div', { class: 'cf-hero-meta' }, [
      el('div', { class: 'cf-hero-title' }, store.projectId === 'all' ? 'All projects' : (store.project(store.projectId)?.name || '')),
      el('div', { class: 'cf-hero-stats' }, [
        chip(`${s.current} active`, 'live'),
        s.overdue ? chip(`${s.overdue} overdue`, 'bad') : null,
        chip(`${s.done}/${s.total} done`, 'muted'),
      ]),
    ]),
  ]));

  if (!tasks.length) { main.appendChild(empty('No work packages for this project.')); return; }

  const section = (label, list, cls) => {
    if (!list.length) return;
    main.appendChild(el('div', { class: 'cf-sec' }, [
      el('span', { class: 'cf-sec-dot ' + cls }), `${label}`, el('span', { class: 'cf-sec-n' }, String(list.length)),
    ]));
    list.forEach((t) => main.appendChild(taskCard(t)));
  };
  section('Overdue', buckets.overdue, 'bad');
  section('In progress', buckets.current, 'live');
  section('Upcoming', buckets.upcoming, 'soft');
  if (buckets.milestones.length) section('Milestones', buckets.milestones, 'mile');
  section('Done', buckets.done, 'good');
}

function taskCard(t) {
  const si = statusInfo(t.status);
  const crew = store.crew(t.crewId);
  const due = dueLabel(t.end);
  return el('div', { class: 'cf-card' + (t.pending ? ' pending' : ''), onclick: () => openTaskSheet(t.id) }, [
    el('div', { class: 'cf-card-bar', style: { background: tradeColor(t.trade) } }),
    el('div', { class: 'cf-card-body' }, [
      el('div', { class: 'cf-card-top' }, [
        t.milestone ? el('span', { class: 'cf-mile' }, '◆') : null,
        el('div', { class: 'cf-card-name' }, t.name),
      ]),
      el('div', { class: 'cf-card-meta' }, [
        el('span', { class: 'cf-tag', style: { color: tradeColor(t.trade) } }, tradeName(t.trade)),
        crew ? el('span', { class: 'cf-muted' }, '· ' + crew.name) : null,
      ]),
      el('div', { class: 'cf-card-foot' }, [
        el('span', { class: 'cf-status', style: { color: si.color, borderColor: si.color } }, si.label),
        el('span', { class: 'cf-due ' + due.tone }, due.text),
        t.pending ? el('span', { class: 'cf-pendtag' }, '⟳ queued') : null,
      ]),
    ]),
    el('div', { class: 'cf-card-pct' }, (t.progress || 0) + '%'),
  ]);
}

function openTaskSheet(id) {
  const t = store.task(id);
  if (!t) return;
  const editable = store.canEditProject(t.projectId) && !t.milestone;
  openSheet(t.name, (body) => {
    const crew = store.crew(t.crewId);
    const proj = store.project(t.projectId);
    body.appendChild(el('div', { class: 'sheet-meta' }, [
      metaRow('Project', proj ? proj.name : '—'),
      metaRow('Trade', tradeName(t.trade)),
      metaRow('Crew', crew ? `${crew.name} (${crew.lead})` : 'Unassigned'),
      metaRow('Dates', `${Dates.fmt(t.start)} → ${Dates.fmtLong(t.end)}`),
      t.lastEditedBy ? metaRow('Last edit', t.lastEditedBy) : null,
    ]));

    if (!editable) {
      body.appendChild(el('div', { class: 'sheet-note' }, t.milestone ? 'Milestone marker — tracked, not crew-editable.' : 'Read-only — you don’t have edit access to this project.'));
      return;
    }

    // progress stepper
    const pctEl = el('div', { class: 'step-pct' }, (t.progress || 0) + '%');
    const apply = (val) => { store.updateTaskProgress(t.id, val); pctEl.textContent = val + '%'; };
    body.appendChild(el('div', { class: 'sheet-label' }, 'Progress'));
    body.appendChild(el('div', { class: 'stepper' }, [
      el('button', { class: 'step-btn', onclick: () => apply(stepProgress(store.task(id).progress, -1)) }, '−'),
      pctEl,
      el('button', { class: 'step-btn', onclick: () => apply(stepProgress(store.task(id).progress, +1)) }, '+'),
    ]));
    const quick = el('div', { class: 'step-quick' }, [0, 25, 50, 75, 100].map((v) =>
      el('button', { class: 'qbtn', onclick: () => apply(v) }, v + '%')));
    body.appendChild(quick);

    // status chips
    body.appendChild(el('div', { class: 'sheet-label' }, 'Status'));
    const chips = el('div', { class: 'status-chips' });
    const rebuild = () => {
      clear(chips);
      const cur = store.task(id).status;
      Object.entries(STATUSES).forEach(([key, info]) => {
        chips.appendChild(el('button', {
          class: 'schip' + (cur === key ? ' on' : ''),
          style: cur === key ? { background: info.color, borderColor: info.color, color: '#0e1116' } : { borderColor: info.color, color: info.color },
          onclick: () => { store.updateTaskStatus(id, key); rebuild(); pctEl.textContent = (store.task(id).progress || 0) + '%'; },
        }, info.label));
      });
    };
    rebuild();
    body.appendChild(chips);
  });
}

// --- PUNCH tab --------------------------------------------------------------
function renderPunch(main) {
  const items = store.punch().slice().sort((a, b) => {
    const o = { open: 0, rejected: 1, ready: 2, accepted: 3 };
    return (o[a.status] - o[b.status]) || (a.number < b.number ? -1 : 1);
  });
  const can = store.canEditProject(store.projectId) || (store.projectId === 'all' && store.editableProjects().length);
  main.appendChild(el('div', { class: 'cf-listhead' }, [
    el('div', {}, `Punch list · ${items.length}`),
  ]));
  if (!items.length) { main.appendChild(empty('No punch items here.')); }
  items.forEach((p) => {
    const proj = store.project(p.projectId);
    main.appendChild(el('div', { class: 'cf-card flat' + (p._provisional ? ' pending' : ''), onclick: () => openPunchSheet(p) }, [
      el('div', { class: 'cf-card-bar prio-' + p.priority }),
      el('div', { class: 'cf-card-body' }, [
        el('div', { class: 'cf-card-top' }, [el('div', { class: 'cf-card-name' }, `${p.number} · ${p.title}`)]),
        el('div', { class: 'cf-card-meta' }, [
          el('span', { class: 'cf-muted' }, p.location || '—'),
          store.projectId === 'all' && proj ? el('span', { class: 'cf-muted' }, '· ' + proj.name) : null,
        ]),
        el('div', { class: 'cf-card-foot' }, [
          el('span', { class: 'pstat pstat-' + p.status }, STATUS_LABEL[p.status] || p.status),
          p.priority === 'high' ? el('span', { class: 'cf-due bad' }, 'high priority') : null,
          p._provisional ? el('span', { class: 'cf-pendtag' }, '⟳ queued') : null,
        ]),
      ]),
    ]));
  });
  if (can) main.appendChild(fab('+ Punch item', () => openPunchCreate()));
}

function openPunchSheet(p) {
  const editable = store.canEditProject(p.projectId) && !p._provisional;
  openSheet(`${p.number} · ${p.title}`, (body) => {
    body.appendChild(el('div', { class: 'sheet-meta' }, [
      metaRow('Location', p.location || '—'),
      metaRow('Trade', tradeName(p.trade)),
      metaRow('Assigned', p.assignedTo || '—'),
      metaRow('Priority', p.priority),
    ]));
    if (!editable) { body.appendChild(el('div', { class: 'sheet-note' }, p._provisional ? 'Queued — will sync when you’re back online.' : 'Read-only for your role.')); return; }
    body.appendChild(el('div', { class: 'sheet-label' }, 'Status'));
    const chips = el('div', { class: 'status-chips' });
    const rebuild = () => {
      clear(chips);
      const cur = (store.punch('all').find((x) => x.id === p.id) || p).status;
      PUNCH_STATUSES.forEach((st) => chips.appendChild(el('button', {
        class: 'schip' + (cur === st ? ' on' : ''),
        onclick: () => { store.updatePunchStatus(p.id, st); rebuild(); },
      }, STATUS_LABEL[st] || st)));
    };
    rebuild();
    body.appendChild(chips);
  });
}

function openPunchCreate() {
  openSheet('New punch item', (body, close) => {
    const proj = pickProject();
    const title = field('Title', el('input', { class: 'cf-input', placeholder: 'e.g. Touch-up paint at stair 2' }));
    const location = field('Location', el('input', { class: 'cf-input', placeholder: 'Grid / area' }));
    const trade = field('Trade', selectFrom(Object.entries(TRADES).map(([k, v]) => [k, v.label])));
    const priority = field('Priority', selectFrom(PUNCH_PRIORITIES.map((p) => [p, p]), 'normal'));
    const assigned = field('Assigned to', el('input', { class: 'cf-input', placeholder: 'Crew / sub' }));
    const err = el('div', { class: 'cf-formerr' });
    body.append(proj.row, title.row, location.row, trade.row, priority.row, assigned.row, err,
      el('button', { class: 'cf-submit', onclick: () => {
        const projectId = proj.value();
        if (!projectId) { err.textContent = 'Pick a project.'; return; }
        if (!title.el.value.trim()) { err.textContent = 'A title is required.'; return; }
        store.createPunch({
          projectId, title: title.el.value.trim(), location: location.el.value.trim(),
          trade: trade.el.value, priority: priority.el.value, assignedTo: assigned.el.value.trim(),
        });
        store.notify('Punch item added.', 'info');
        close();
      } }, 'Add punch item'));
  });
}

// --- REPORTS tab ------------------------------------------------------------
const WX_ICON = { Clear: '☀', 'Partly Cloudy': '⛅', Cloudy: '☁', Rain: '🌧', Storm: '⛈', Snow: '❄', Windy: '🌬', Fog: '🌫' };

function renderReports(main) {
  const reports = store.reports();
  const can = store.canEditProject(store.projectId) || (store.projectId === 'all' && store.editableProjects().length);
  main.appendChild(el('div', { class: 'cf-listhead' }, [el('div', {}, `Daily reports · ${reports.length}`)]));
  if (!reports.length) main.appendChild(empty('No field reports yet.'));
  reports.forEach((r) => {
    const proj = store.project(r.projectId);
    const temp = (r.tempLow != null || r.tempHigh != null) ? ` · ${r.tempLow ?? '?'}–${r.tempHigh ?? '?'}°` : '';
    main.appendChild(el('div', { class: 'cf-card flat' + (r._provisional ? ' pending' : '') }, [
      el('div', { class: 'cf-card-body' }, [
        el('div', { class: 'cf-card-top' }, [el('div', { class: 'cf-card-name' }, Dates.fmtLong(r.date))]),
        el('div', { class: 'cf-card-meta' }, [
          el('span', {}, `${WX_ICON[r.weather] || ''} ${r.weather}${temp}`),
          el('span', { class: 'cf-muted' }, `· 👷 ${r.manpower}`),
          store.projectId === 'all' && proj ? el('span', { class: 'cf-muted' }, '· ' + proj.name) : null,
        ]),
        r.workPerformed ? el('div', { class: 'cf-card-note' }, r.workPerformed) : null,
        r.delays ? el('div', { class: 'cf-card-note warn' }, '⚠ ' + r.delays) : null,
        r._provisional ? el('div', { class: 'cf-card-foot' }, [el('span', { class: 'cf-pendtag' }, '⟳ queued')]) : null,
      ]),
    ]));
  });
  if (can) main.appendChild(fab('+ Daily report', () => openReportCreate()));
}

function openReportCreate() {
  openSheet('New daily report', (body, close) => {
    const proj = pickProject();
    const date = field('Date', el('input', { class: 'cf-input', type: 'date', value: Dates.today() }));
    const weather = field('Weather', selectFrom(WEATHER.map((w) => [w, w]), 'Clear'));
    const lo = el('input', { class: 'cf-input', type: 'number', placeholder: 'Low °' });
    const hi = el('input', { class: 'cf-input', type: 'number', placeholder: 'High °' });
    const temps = el('div', { class: 'cf-field' }, [el('label', { class: 'cf-flabel' }, 'Temp range'), el('div', { class: 'cf-row2' }, [lo, hi])]);
    const manpower = field('Manpower', el('input', { class: 'cf-input', type: 'number', placeholder: 'Workers on site', value: '0' }));
    const work = field('Work performed', el('textarea', { class: 'cf-input', rows: '3', placeholder: 'What got done today' }));
    const deliveries = field('Deliveries', el('input', { class: 'cf-input', placeholder: 'Materials / equipment' }));
    const delays = field('Delays', el('input', { class: 'cf-input', placeholder: 'Weather / access / other' }));
    const err = el('div', { class: 'cf-formerr' });
    body.append(proj.row, date.row, weather.row, temps, manpower.row, work.row, deliveries.row, delays.row, err,
      el('button', { class: 'cf-submit', onclick: () => {
        const projectId = proj.value();
        if (!projectId) { err.textContent = 'Pick a project.'; return; }
        store.createReport({
          projectId, date: date.el.value || Dates.today(), weather: weather.el.value,
          tempLow: lo.value, tempHigh: hi.value, manpower: manpower.el.value,
          workPerformed: work.el.value.trim(), deliveries: deliveries.el.value.trim(), delays: delays.el.value.trim(),
        });
        store.notify('Daily report logged.', 'info');
        close();
      } }, 'Submit report'));
  });
}

// --- CHAT tab ---------------------------------------------------------------
function msgTime(iso) { return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); }
function msgDay(iso) { return Dates.fmtLong(Dates.iso(new Date(iso))); }
function mentionNodes(text) {
  return String(text || '').split(/(@[a-zA-Z0-9_.-]+)/g)
    .map((p) => (/^@[a-zA-Z0-9_.-]+$/.test(p) ? el('span', { class: 'cf-mention' }, p) : p));
}

function renderChat(main) {
  if (ui.chatChannelId && store.channel(ui.chatChannelId)) return renderConversation(main, ui.chatChannelId);
  ui.chatChannelId = null;
  const channels = store.channels.filter((c) => store.projectId === 'all' || c.projectId === store.projectId);
  main.appendChild(el('div', { class: 'cf-listhead' }, [el('div', {}, `Channels · ${channels.length}`)]));
  if (!channels.length) { main.appendChild(empty('No channels for this project.')); return; }
  channels.forEach((c) => {
    const proj = store.project(c.projectId);
    const last = store.lastMessageFor(c.id);
    const un = store.unread(c.id);
    main.appendChild(el('div', { class: 'cf-card flat', onclick: () => { ui.chatChannelId = c.id; render(); } }, [
      el('div', { class: 'cf-card-bar', style: { background: (proj && proj.color) || '#888' } }),
      el('div', { class: 'cf-card-body' }, [
        el('div', { class: 'cf-card-top' }, [
          el('div', { class: 'cf-card-name' }, c.name),
          un ? el('span', { class: 'cf-badge cf-badge-inline' }, String(un)) : null,
        ]),
        el('div', { class: 'cf-card-note' }, last ? `${last.authorName.split(' ')[0]}: ${last.body}` : 'No messages yet'),
        last ? el('div', { class: 'cf-card-foot' }, [el('span', { class: 'cf-muted' }, msgTime(last.createdAt))]) : null,
      ]),
    ]));
  });
}

function renderConversation(main, channelId) {
  const ch = store.channel(channelId);
  const msgs = store.messagesFor(channelId);
  main.appendChild(el('div', { class: 'cf-chat-head' }, [
    el('button', { class: 'cf-back', onclick: () => { ui.chatChannelId = null; render(); } }, '‹'),
    el('div', { class: 'cf-chat-title' }, ch.name),
  ]));

  const stream = el('div', { class: 'cf-chat-stream' });
  if (!msgs.length) stream.appendChild(el('div', { class: 'cf-empty' }, 'No messages yet. Say hello.'));
  let lastDay = null;
  msgs.forEach((m) => {
    const day = msgDay(m.createdAt);
    if (day !== lastDay) { stream.appendChild(el('div', { class: 'cf-chat-day' }, day)); lastDay = day; }
    const mine = m.authorId === store._uid();
    const bot = m.authorId === 'dispatcher';
    stream.appendChild(el('div', { class: 'cf-bubble-row' + (mine ? ' mine' : '') }, [
      el('div', { class: 'cf-bubble' + (mine ? ' mine' : '') + (bot ? ' bot' : '') + (m._provisional ? ' pending' : '') }, [
        mine ? null : el('div', { class: 'cf-bubble-author' }, m.authorName),
        m.body ? el('div', { class: 'cf-bubble-body' }, mentionNodes(m.body)) : null,
        m.voice ? el('div', { class: 'cf-bubble-voice' }, [
          el('audio', { class: 'cf-audio', controls: '', preload: 'none', src: store.voiceSrc(m) }),
          el('span', { class: 'cf-voice-dur' }, '🎤 ' + fmtDur(m.voice.dur)),
        ]) : null,
        el('div', { class: 'cf-bubble-meta' }, [
          el('span', {}, msgTime(m.createdAt)),
          mine ? el('span', { class: 'cf-tick' }, m._provisional ? '🕓' : '✓') : null,
        ]),
      ]),
    ]));
  });
  main.appendChild(stream);

  const typers = store.typingIn(channelId);
  if (typers.length) main.appendChild(el('div', { class: 'cf-typing' }, `${typers.join(', ')} ${typers.length > 1 ? 'are' : 'is'} typing…`));

  if (store.canPost(channelId) && ui.chatRec) {
    const timeLbl = el('span', { class: 'cf-rec-time' }, '0:00');
    if (ui.chatRecInt) clearInterval(ui.chatRecInt);
    ui.chatRecSec = ui.chatRec.elapsed();
    timeLbl.textContent = fmtDur(ui.chatRecSec);
    ui.chatRecInt = setInterval(() => { ui.chatRecSec += 1; timeLbl.textContent = fmtDur(ui.chatRecSec); }, 1000);
    const finish = (sendIt) => async () => {
      clearInterval(ui.chatRecInt); ui.chatRecInt = null;
      const r = ui.chatRec; ui.chatRec = null;
      if (sendIt) { const clip = await r.stop(); if (clip && clip.b64) store.sendVoice(channelId, clip); } else r.cancel();
      render();
    };
    main.appendChild(el('div', { class: 'cf-chat-composer recording' }, [
      el('span', { class: 'cf-rec-dot' }), el('span', { class: 'cf-rec-lbl' }, 'Recording'), timeLbl,
      el('button', { class: 'cf-rec-cancel', onclick: finish(false) }, '✕'),
      el('button', { class: 'cf-chat-send', onclick: finish(true) }, '➤'),
    ]));
  } else if (store.canPost(channelId)) {
    const ta = el('textarea', { class: 'cf-input cf-chat-input', rows: '1', placeholder: 'Message…' });
    const send = () => { const t = ta.value.trim(); if (!t) return; store.sendMessage(channelId, t); ta.value = ''; render(); };
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
    ta.addEventListener('input', () => store.postTyping(channelId));
    const btns = [];
    if (supportsDictation()) {
      let dict = null;
      const mic = el('button', { class: 'cf-chat-ico', title: 'Dictate' }, '🎙');
      mic.onclick = () => {
        if (dict) { dict.stop(); dict = null; mic.classList.remove('on'); return; }
        const base = ta.value ? ta.value + ' ' : '';
        dict = startDictation((f, i) => { ta.value = base + f + i; }, () => { dict = null; mic.classList.remove('on'); });
        if (dict) mic.classList.add('on');
      };
      btns.push(mic);
    }
    const recBtn = supportsRecording()
      ? el('button', { class: 'cf-chat-ico rec', title: 'Voice note', onclick: async () => { try { ui.chatRec = await startRecording(); render(); } catch { store.notify('Microphone unavailable.', 'warn'); } } }, '🎤')
      : null;
    main.appendChild(el('div', { class: 'cf-chat-composer' }, [...btns, ta, el('button', { class: 'cf-chat-send', onclick: send }, '➤'), recBtn]));
  } else {
    main.appendChild(el('div', { class: 'cf-chat-composer readonly' }, store.can('write') ? 'No posting access to this project' : 'Read-only role'));
  }

  store.markRead(channelId);
  setTimeout(() => { const s = main.querySelector('.cf-chat-stream'); if (s) s.scrollTop = s.scrollHeight; }, 0);
}

// --- ME tab -----------------------------------------------------------------
function renderMe(main) {
  const pending = store.pendingCount();
  main.appendChild(el('div', { class: 'cf-me' }, [
    el('div', { class: 'cf-avatar' }, initials(store.user)),
    el('div', { class: 'cf-me-name' }, store.user || '—'),
    el('div', { class: 'cf-me-role' }, (store.role || '').toUpperCase() + (store.isUnrestricted() ? ' · all projects' : (store.scope.length ? ' · ' + store.scope.length + ' project(s)' : ''))),
  ]));
  main.appendChild(el('div', { class: 'cf-mecard' }, store.local ? [
    meRow('Mode', 'Local demo', 'warn'),
    meRow('Data', 'On this device only', ''),
    meRow('Schedule rev', store.rev != null ? '#' + store.rev : '—'),
  ] : [
    meRow('Connection', store.online ? 'Online' : 'Offline', store.online ? 'good' : 'bad'),
    meRow('Pending sync', pending ? pending + ' queued change(s)' : 'All synced', pending ? 'warn' : 'good'),
    meRow('Schedule rev', store.rev != null ? '#' + store.rev : '—'),
  ]));
  main.appendChild(el('div', { class: 'cf-me-actions' }, [
    el('a', { class: 'cf-link', href: '../', target: '_blank', rel: 'noopener' }, 'Open full BuildFlow desktop →'),
    store.local
      ? el('button', { class: 'cf-submit danger', onclick: () => store.logout() }, 'Reset demo data')
      : el('button', { class: 'cf-submit danger', onclick: () => store.logout() }, 'Sign out'),
  ]));
  if (store.local) main.appendChild(el('div', { class: 'cf-empty', style: { padding: '14px 6px 0' } }, 'Demo mode — no server. Changes are saved only in this browser. Sign-in + live multi-user sync activate when served by the BuildFlow API.'));
  main.appendChild(el('div', { class: 'cf-foot' }, 'Corefield · BuildFlow field companion'));
}

// --- shared bits ------------------------------------------------------------
const chip = (text, cls) => el('span', { class: 'hchip ' + cls }, text);
const empty = (msg) => el('div', { class: 'cf-empty' }, msg);
const metaRow = (k, v) => el('div', { class: 'mrow' }, [el('span', { class: 'mrow-k' }, k), el('span', { class: 'mrow-v' }, v)]);
const meRow = (k, v, tone) => el('div', { class: 'merow' }, [el('span', {}, k), el('span', { class: 'me-v ' + (tone || '') }, v)]);

function field(label, input) {
  const row = el('div', { class: 'cf-field' }, [el('label', { class: 'cf-flabel' }, label), input]);
  return { row, el: input };
}
function selectFrom(pairs, selected) {
  return el('select', { class: 'cf-input' }, pairs.map(([v, l]) => el('option', { value: v, selected: v === selected }, l)));
}
function pickProject() {
  const editable = store.editableProjects();
  const def = store.projectId !== 'all' && editable.some((p) => p.id === store.projectId) ? store.projectId : (editable[0] && editable[0].id);
  const input = selectFrom(editable.map((p) => [p.id, p.name]), def);
  const row = el('div', { class: 'cf-field' }, [el('label', { class: 'cf-flabel' }, 'Project'), input]);
  return { row, el: input, value: () => input.value };
}
function fab(label, onclick) { return el('button', { class: 'cf-fab', onclick }, label); }

// --- render orchestration ---------------------------------------------------
const VIEW = { work: renderWork, chat: renderChat, punch: renderPunch, reports: renderReports, me: renderMe };

function render() {
  if (!built) return;
  renderBar();
  renderTabBar();
  const main = document.getElementById('cf-main');
  if (!main) return;
  clear(main);
  main.className = 'cf-main' + (ui.tab === 'chat' && ui.chatChannelId ? ' chatting' : '');
  main.scrollTop = 0;
  VIEW[ui.tab](main);
}

// --- login ------------------------------------------------------------------
function renderLogin() {
  built = false;
  clear(root);
  const u = el('input', { class: 'cf-input', type: 'text', placeholder: 'Username', autocomplete: 'username' });
  const p = el('input', { class: 'cf-input', type: 'password', placeholder: 'Password', autocomplete: 'current-password' });
  const err = el('div', { class: 'cf-formerr' });
  const btn = el('button', { class: 'cf-submit', type: 'submit' }, 'Sign in');
  const submit = async (e) => {
    if (e) e.preventDefault();
    err.textContent = ''; btn.disabled = true; btn.textContent = 'Signing in…';
    const res = await store.login(u.value.trim(), p.value);
    if (!res.ok) { err.textContent = res.error; btn.disabled = false; btn.textContent = 'Sign in'; p.value = ''; }
  };
  root.appendChild(el('div', { class: 'cf-login' }, [
    el('div', { class: 'cf-login-brand' }, [
      el('div', { class: 'cf-mark lg' }, '◭'),
      el('div', { class: 'cf-login-name' }, 'Corefield'),
      el('div', { class: 'cf-login-sub' }, 'BuildFlow field crew app'),
    ]),
    el('form', { class: 'cf-login-form', onsubmit: submit }, [u, p, err, btn]),
    el('div', { class: 'cf-login-demo' }, [
      el('div', { class: 'cf-demo-t' }, 'Demo accounts'),
      el('div', {}, 'awhitfield / build123 — PM · Riverside'),
      el('div', {}, 'psandoval / north123 — PM · Northgate + Civic'),
      el('div', {}, 'admin / admin123 — full access'),
    ]),
  ]));
  setTimeout(() => u.focus(), 50);
}

function renderLoading() {
  clear(root);
  root.appendChild(el('div', { class: 'cf-login' }, el('div', { class: 'cf-mark lg pulse' }, '◭')));
}

function buildShell() {
  clear(root);
  root.append(
    el('header', { id: 'cf-bar', class: 'cf-bar' }),
    el('main', { id: 'cf-main', class: 'cf-main' }),
    el('nav', { id: 'cf-tabs', class: 'cf-tabbar' }),
    el('div', { class: 'cf-toasts' }),
  );
  built = true;
  render();
}

function renderShell(authState) {
  if (authState === 'required') return renderLogin();
  if (authState === 'unknown') return built ? null : renderLoading();
  if (!built) buildShell(); else render();
}

// --- boot -------------------------------------------------------------------
function boot() {
  root = document.getElementById('cf-app');
  store.onAuth((authState) => renderShell(authState));
  store.subscribe(() => render());
  store.onNotice((msg, tone = 'info') => {
    const stack = document.querySelector('.cf-toasts');
    if (!stack) return;
    const t = el('div', { class: 'cf-toast ' + tone }, msg);
    stack.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 250); }, 3600);
  });
  renderShell(store.authState);

  // PWA: register the service worker for offline + installability.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* non-fatal */ });
  }
}

if (typeof window !== 'undefined') window.addEventListener('DOMContentLoaded', boot);

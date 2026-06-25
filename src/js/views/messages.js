// ============================================================================
//  messages.js (view) — Communication monitor (web). A PM/admin oversight
//  surface over all team channels: pick a channel, read the full history, post
//  if you have access, search across messages, and export a channel to CSV.
//  Reads are portfolio-wide (matching the app's read model); posting to a
//  project channel is gated by that project's write scope (server-enforced).
// ============================================================================
import { store, Dates } from '../data.js';
import { el, clear } from '../utils.js';
import { searchMessages, parseMentions } from '../messaging.js';

const view = { channelId: null, search: '' };

function initials(name) {
  return String(name || '?').split(/[\s.]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
}
function timeOf(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
function dayOf(iso) { return Dates.fmtLong(Dates.iso(new Date(iso))); }

// Body with @mentions highlighted (text nodes only — no HTML injection).
function bodyNodes(text) {
  const parts = String(text || '').split(/(@[a-zA-Z0-9_.-]+)/g);
  return parts.map((p) => (/^@[a-zA-Z0-9_.-]+$/.test(p) ? el('span', { class: 'msg-mention' }, p) : p));
}

function csvEscape(s) { return '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"'; }
function exportChannelCsv(channel) {
  const rows = [['timestamp', 'author', 'message']];
  store.messagesFor(channel.id).forEach((m) => rows.push([m.createdAt, m.authorName, m.body]));
  const csv = rows.map((r) => r.map(csvEscape).join(',')).join('\n');
  const a = el('a', {
    href: 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv),
    download: `messages-${channel.id}.csv`,
  });
  document.body.appendChild(a); a.click(); a.remove();
}

export function renderMessages(mount, ctx) {
  clear(mount);
  const rerender = () => renderMessages(mount, ctx);

  // Channels scoped by the global project filter.
  const channels = store.channels.filter((c) => ctx.projectId === 'all' || c.projectId === ctx.projectId);
  if (view.channelId && !channels.some((c) => c.id === view.channelId)) view.channelId = null;
  if (!view.channelId) view.channelId = channels[0] && channels[0].id;
  const channel = store.channel(view.channelId);

  const wrap = el('div', { class: 'msg-view' });

  // ---- sidebar: channel list ----
  const totalUnread = store.totalUnread();
  const side = el('div', { class: 'msg-side' }, [
    el('div', { class: 'msg-side-head' }, [
      el('span', { class: 'msg-monitor-tag' }, '◉ Monitor'),
      el('span', { class: 'msg-side-sub' }, store.isUnrestricted() ? 'All projects' : `${store.scope.length || 'all'} project(s)`),
    ]),
    el('div', { class: 'msg-chan-list' }, channels.length ? channels.map((c) => {
      const proj = store.project(c.projectId);
      const last = store.lastMessageFor(c.id);
      const un = store.unread(c.id);
      return el('div', {
        class: 'msg-chan' + (c.id === view.channelId ? ' active' : ''),
        onclick: () => { view.channelId = c.id; store.markRead(c.id); rerender(); },
      }, [
        el('span', { class: 'msg-chan-dot', style: { background: (proj && proj.color) || '#888' } }),
        el('div', { class: 'msg-chan-meta' }, [
          el('div', { class: 'msg-chan-name' }, c.name),
          el('div', { class: 'msg-chan-prev' }, last ? `${last.authorName.split(' ')[0]}: ${last.body}` : 'No messages yet'),
        ]),
        el('div', { class: 'msg-chan-side' }, [
          last ? el('div', { class: 'msg-chan-time' }, timeOf(last.createdAt)) : null,
          un ? el('span', { class: 'msg-unread' }, String(un)) : null,
        ]),
      ]);
    }) : [el('div', { class: 'empty' }, 'No channels for this project.')]),
  ]);

  // ---- main: conversation or search results ----
  const main = el('div', { class: 'msg-main' });

  const searchInput = el('input', {
    class: 'input msg-search', type: 'search', placeholder: 'Search all messages…', value: view.search,
    oninput: (e) => { view.search = e.target.value; renderResults(); },
  });
  const head = el('div', { class: 'msg-main-head' }, [
    el('div', { class: 'msg-main-title' }, channel ? channel.name : 'Messages'),
    el('div', { class: 'msg-head-actions' }, [
      searchInput,
      channel ? el('button', { class: 'btn sm ghost', onclick: () => exportChannelCsv(channel), title: 'Export this channel to CSV' }, '⬇ CSV') : null,
    ]),
  ]);
  main.appendChild(head);

  const stream = el('div', { class: 'msg-stream' });
  main.appendChild(stream);

  function renderResults() {
    clear(stream);
    if (view.search.trim()) {
      const visibleIds = new Set(channels.map((c) => c.id));
      const hits = searchMessages(store.messages, view.search).filter((m) => visibleIds.has(m.channelId));
      stream.appendChild(el('div', { class: 'msg-search-note' }, `${hits.length} result${hits.length === 1 ? '' : 's'} for “${view.search.trim()}”`));
      hits.slice(-200).forEach((m) => {
        const ch = store.channel(m.channelId);
        stream.appendChild(el('div', { class: 'msg-result', onclick: () => { view.channelId = m.channelId; view.search = ''; store.markRead(m.channelId); rerender(); } }, [
          el('div', { class: 'msg-result-ch' }, ch ? ch.name : m.channelId),
          el('div', { class: 'msg-row' }, [
            el('span', { class: 'msg-avatar' }, initials(m.authorName)),
            el('div', {}, [
              el('div', { class: 'msg-byline' }, [el('span', { class: 'msg-author' }, m.authorName), el('span', { class: 'msg-time' }, dayOf(m.createdAt) + ' · ' + timeOf(m.createdAt))]),
              el('div', { class: 'msg-body' }, bodyNodes(m.body)),
            ]),
          ]),
        ]));
      });
      return;
    }
    // Normal conversation stream, grouped by day.
    if (!channel) { stream.appendChild(el('div', { class: 'empty' }, 'Select a channel.')); return; }
    const msgs = store.messagesFor(channel.id);
    if (!msgs.length) { stream.appendChild(el('div', { class: 'empty' }, 'No messages yet. Start the conversation.')); }
    let lastDay = null;
    msgs.forEach((m) => {
      const day = dayOf(m.createdAt);
      if (day !== lastDay) { stream.appendChild(el('div', { class: 'msg-daysep' }, day)); lastDay = day; }
      const mine = m.authorId === store._uid();
      stream.appendChild(el('div', { class: 'msg-row' + (mine ? ' mine' : '') }, [
        el('span', { class: 'msg-avatar' }, initials(m.authorName)),
        el('div', { class: 'msg-bubble-wrap' }, [
          el('div', { class: 'msg-byline' }, [el('span', { class: 'msg-author' }, m.authorName), el('span', { class: 'msg-time' }, timeOf(m.createdAt))]),
          el('div', { class: 'msg-body' }, bodyNodes(m.body)),
        ]),
      ]));
    });
    stream.scrollTop = stream.scrollHeight;
  }
  renderResults();

  // ---- composer ----
  if (channel && !view.search.trim()) {
    const canPost = store.canPost(channel.id);
    if (canPost) {
      const ta = el('textarea', { class: 'input msg-input', rows: '1', placeholder: `Message ${channel.name}…  (@name to mention)` });
      const send = () => {
        const text = ta.value.trim();
        if (!text) return;
        store.sendMessage(channel.id, text);
        ta.value = '';
        rerender();
        setTimeout(() => { const t = mount.querySelector('.msg-input'); if (t) t.focus(); }, 0);
      };
      ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
      main.appendChild(el('div', { class: 'msg-composer' }, [ta, el('button', { class: 'btn primary', onclick: send }, 'Send')]));
    } else {
      main.appendChild(el('div', { class: 'msg-composer readonly' }, store.can('write')
        ? 'You don’t have posting access to this project — monitoring only.'
        : 'Read-only role — monitoring only.'));
    }
  }

  wrap.appendChild(side);
  wrap.appendChild(main);
  mount.appendChild(wrap);

  // Viewing a channel marks it read (no-op when nothing new → no loop).
  if (channel && !view.search.trim()) store.markRead(channel.id);
}

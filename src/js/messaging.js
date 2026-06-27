// ============================================================================
//  messaging.js — Pure team-messaging model (channels, messages, read state).
//  Shared by the browser stores AND the Node server, so the rules live once.
//  No browser/node globals; timestamps are passed in or default to ISO now.
//
//  Design (see docs/messaging-research-and-plan.md): server-persistent like
//  Slack (history + search + audit + RBAC), NOT consumer E2EE — so a PM/admin
//  can MONITOR communication from the web. One channel per project; messages
//  are capped per channel to stay honest with the zero-DB JSON store.
// ============================================================================

export const MSG_CAP = 200;            // keep the most recent N messages per channel
export const MAX_BODY = 4000;          // hard cap on a single message body

// Stable id for a project's default channel.
export const channelIdForProject = (projectId) => 'ch-' + projectId;

export function makeChannel(partial) {
  return {
    id: partial.id || channelIdForProject(partial.projectId),
    type: partial.type || 'project',                 // 'project' | 'group' | 'dm'
    projectId: partial.projectId || null,
    name: partial.name || 'Channel',
    memberIds: Array.isArray(partial.memberIds) ? partial.memberIds : [],
    createdBy: partial.createdBy || null,
    createdAt: partial.createdAt || new Date().toISOString(),
    archived: !!partial.archived,
  };
}

// Build a fully-formed message from a partial, assigning the next global id.
export function makeMessage(existing, partial) {
  const maxId = Math.max(0, ...(existing || []).map((m) => +String(m.id).slice(1) || 0));
  return {
    id: 'm' + (maxId + 1),
    clientId: partial.clientId || null,             // the sender's optimistic id (qid) — lets a client match its provisional to this echo and de-dupe
    channelId: partial.channelId,
    authorId: partial.authorId || null,             // username (stable) for attribution
    authorName: partial.authorName || 'Unknown',
    body: String(partial.body == null ? '' : partial.body).slice(0, MAX_BODY),
    attachments: Array.isArray(partial.attachments) ? partial.attachments : [],
    voice: partial.voice || null,                   // { id, dur, mime } (audio served from /api/voice/:id) or { url, dur, mime } (demo data-URL)
    photo: partial.photo || null,                   // { id, mime, w, h } (served from /api/photos/:id) or { url, w, h } (demo data-URL)
    linkedTo: partial.linkedTo || null,             // { kind:'task'|'rfi'|'punch', id }
    createdAt: partial.createdAt || new Date().toISOString(),
    editedAt: null,
    deleted: false,
    rev: 1,
  };
}

// One default channel per project (used by the seed + normalize backfill).
export function seedChannels(projects) {
  return (projects || []).map((p) => makeChannel({ type: 'project', projectId: p.id, name: p.name }));
}

// Messages for a channel, oldest→newest, excluding tombstoned ones unless asked.
export function messagesForChannel(messages, channelId, { includeDeleted = false } = {}) {
  return (messages || [])
    .filter((m) => m.channelId === channelId && (includeDeleted || !m.deleted))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}

// Trim a channel's history to the most recent MSG_CAP, returning the new array.
export function capChannel(messages, channelId, cap = MSG_CAP) {
  const inCh = messagesForChannel(messages, channelId, { includeDeleted: true });
  if (inCh.length <= cap) return messages;
  const drop = new Set(inCh.slice(0, inCh.length - cap).map((m) => m.id));
  return messages.filter((m) => !drop.has(m.id));
}

// Read tracking is a map: reads[userId][channelId] = lastReadAt (ISO string).
export function lastRead(reads, userId, channelId) {
  return (reads && reads[userId] && reads[userId][channelId]) || null;
}
export function setRead(reads, userId, channelId, at) {
  const next = { ...(reads || {}) };
  next[userId] = { ...(next[userId] || {}), [channelId]: at };
  return next;
}
export function unreadCount(messages, channelId, lastReadAt, selfId) {
  return (messages || []).filter((m) => m.channelId === channelId && !m.deleted
    && (!lastReadAt || m.createdAt > lastReadAt)
    && m.authorId !== selfId).length;                // your own messages aren't "unread"
}

// The latest non-deleted message in a channel (for list previews).
export function lastMessage(messages, channelId) {
  const inCh = messagesForChannel(messages, channelId);
  return inCh.length ? inCh[inCh.length - 1] : null;
}

// A task's Activity feed: messages linked to that task (the filtered/synced
// view of the project channel — the same store, a different lens), oldest→newest.
export function messagesForTask(messages, taskId) {
  return (messages || [])
    .filter((m) => !m.deleted && m.linkedTo && m.linkedTo.kind === 'task' && m.linkedTo.id === taskId)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}
export function taskActivityCount(messages, taskId) {
  return messagesForTask(messages, taskId).length;
}

// Parse @mentions out of a body → array of mentioned usernames (deduped).
export function parseMentions(body) {
  const out = [];
  const re = /@([a-zA-Z0-9_.-]+)/g;
  let m;
  while ((m = re.exec(String(body || '')))) { if (!out.includes(m[1])) out.push(m[1]); }
  return out;
}

// Full-text-ish filter across messages (case-insensitive substring on body/author).
export function searchMessages(messages, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  return (messages || []).filter((m) => !m.deleted
    && ((m.body && m.body.toLowerCase().includes(q)) || (m.authorName && m.authorName.toLowerCase().includes(q))));
}

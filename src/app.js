/* Notepad - the window. Rust owns the folder; this owns what you see.
   Notes arrive once at startup and stay in memory, so search, the switcher
   and the tab strip never touch the disk. */

'use strict';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const dialog = window.__TAURI__.dialog;

const $ = s => document.querySelector(s);
const el = {
  app: $('#app'), list: $('#list'), editor: $('#editor'), preview: $('#preview'),
  empty: $('#empty'), state: $('#state'), count: $('#count'), search: $('#search'),
  ext: $('#ext'), live: $('#live'), folderName: $('#folderName'), rail: $('#rail'),
  strip: $('#strip'), ink: $('#ink'), body: $('#body'),
};

let notes = [];          // every note, trashed ones included
let open = [];           // ids in tab order
let transient = null;    // the one tab that a single click replaces
let current = null;      // the open note, an object inside `notes`
let view = 'notes';
let query = '';
let preview = false;
let root = '';

const prefs = {
  get theme() { return localStorage.getItem('np.theme') || 'auto'; },
  set theme(v) { localStorage.setItem('np.theme', v); },
  get side() { return localStorage.getItem('np.side') || 'shown'; },
  set side(v) { localStorage.setItem('np.side', v); },
  get open() { try { return JSON.parse(localStorage.getItem('np.open')) || []; } catch { return []; } },
  set open(v) { localStorage.setItem('np.open', JSON.stringify(v)); },
  get last() { return localStorage.getItem('np.last') || ''; },
  set last(v) { localStorage.setItem('np.last', v || ''); },
};

const byId = id => notes.find(n => n.id === id);

/* ------------------------------------------------------------ icons */

const ICONS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.3-3.3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  'panel-left': '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  eye: '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/>',
  pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
  note: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>',
  text: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/>',
  files: '<path d="M15 2H9.6A1.6 1.6 0 0 0 8 3.6v12.8c0 .9.7 1.6 1.6 1.6h8.8c.9 0 1.6-.7 1.6-1.6V7Z"/><path d="M15 2v5h5"/><path d="M4.5 7.5v12.9c0 .9.7 1.6 1.6 1.6H15"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  'folder-open': '<path d="M4 20a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h4.5l2 2H19a1 1 0 0 1 1 1v2"/><path d="m6 20 2.4-7.2A1 1 0 0 1 9.3 12H21a1 1 0 0 1 1 1.3L19.6 20Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9Z"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  restore: '<path d="M3 12a9 9 0 1 0 2.6-6.4L3 8"/><path d="M3 3v5h5"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
};

function icon(name, size) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size || 16);
  svg.setAttribute('height', size || 16);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name] || '';
  return svg;
}

/** Fill in every [data-icon] the markup asked for. */
function hydrateIcons(scope) {
  for (const node of (scope || document).querySelectorAll('[data-icon]')) {
    const name = node.dataset.icon;
    const size = Number(node.dataset.size) || 16;
    node.prepend(icon(name, size));
    delete node.dataset.icon;
  }
}

const noteIcon = n => icon(n.ext === 'txt' ? 'text' : 'note', 14);

/* ------------------------------------------------------------ words */

function relative(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 86400 * 7) return Math.floor(s / 86400) + 'd ago';
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function bucket(ms) {
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const t = midnight.getTime();
  if (ms >= t) return 'Today';
  if (ms >= t - 86400000) return 'Yesterday';
  if (ms >= t - 86400000 * 7) return 'Previous 7 days';
  const d = new Date(ms);
  return d.getFullYear() === new Date().getFullYear() ? 'Earlier this year' : String(d.getFullYear());
}

function snippet(n) {
  const body = (n.body || '').replace(/\s+/g, ' ').trim().replace(/^#{1,6}\s*/, '');
  return (body.startsWith(n.name) ? body.slice(n.name.length) : body).trim().slice(0, 140);
}

function announce(m) { el.live.textContent = m; }

function toast(text, action) {
  const t = document.createElement('div'); t.className = 'toast';
  t.appendChild(icon(action ? 'restore' : 'check', 14));
  const s = document.createElement('span'); s.textContent = text; t.appendChild(s);
  if (action) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = action.label;
    b.onclick = () => { t.remove(); action.run(); };
    t.appendChild(b);
  }
  $('#toasts').appendChild(t);
  announce(text);
  setTimeout(() => t.remove(), action ? 7000 : 3200);
}

function failed(e, fallback) {
  const msg = typeof e === 'string' ? e : (e && e.message) || fallback;
  toast(msg);
  return msg;
}

/* ------------------------------------------------------------ saving */

let saveTimer = null, dirty = false, stateTimer = null, shownDirty = false;

function setState(text, tone) {
  el.state.textContent = text;
  el.state.dataset.tone = tone || '';
  el.state.style.opacity = '1';
  clearTimeout(stateTimer);
  if (tone !== 'warn' && text.startsWith('Saved')) {
    stateTimer = setTimeout(() => { el.state.style.opacity = '0'; }, 1600);
  }
}

function touch() {
  if (!current) return;
  dirty = true;
  setState('Saving…');
  if (!shownDirty) { shownDirty = true; renderTabs(); }   // only when the dot appears
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 350);
}

async function flush() {
  clearTimeout(saveTimer);
  if (!dirty || !current) return;
  const note = current, body = note.body;
  dirty = false; shownDirty = false;
  try {
    note.updated = await invoke('save', { id: note.id, body });
    if (current === note && !dirty) setState('Saved just now');
    renderList(); renderTabs();
  } catch (e) {
    dirty = true;
    setState(failed(e, "Couldn't save the note."), 'warn');
  }
}

addEventListener('beforeunload', flush);
addEventListener('blur', flush);
document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });

/* ------------------------------------------------------------ tabs */

const tabEls = new Map();

function makeTab(n) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'doc is-new'; b.setAttribute('role', 'tab');
  b.dataset.id = n.id;

  const ic = document.createElement('span'); ic.className = 'doc__icon';
  const nm = document.createElement('span'); nm.className = 'doc__name';
  const close = document.createElement('span');
  close.className = 'doc__close'; close.setAttribute('role', 'button');
  close.title = 'Close  Ctrl+W';
  close.appendChild(icon('x', 13));
  const dot = document.createElement('span'); dot.className = 'doc__dot'; dot.hidden = true;

  b.append(ic, nm, dot, close);

  b.onclick = e => {
    if (e.target.closest('.doc__close')) { closeTab(b.dataset.id); return; }
    select(b.dataset.id);
  };
  b.ondblclick = e => {
    if (e.target.closest('.doc__close')) return;
    pinTab(b.dataset.id);
    renameNote();
  };
  b.onauxclick = e => { if (e.button === 1) { e.preventDefault(); closeTab(b.dataset.id); } };
  b.oncontextmenu = e => {
    e.preventDefault(); select(b.dataset.id); openMenu(e.clientX, e.clientY);
  };
  // Let it animate open from nothing.
  requestAnimationFrame(() => b.classList.remove('is-new'));
  return b;
}

function renderTabs() {
  // Gone: shrink away, then drop out of the DOM.
  for (const [id, node] of [...tabEls]) {
    if (open.includes(id) && byId(id)) continue;
    tabEls.delete(id);
    node.classList.add('is-closing');
    setTimeout(() => node.remove(), 260);
  }
  // Present: add what is new, refresh the rest.
  for (const id of open) {
    const n = byId(id);
    if (!n) continue;
    let node = tabEls.get(id);
    if (!node) {
      node = makeTab(n);
      tabEls.set(id, node);
      el.rail.appendChild(node);
    }
    node.dataset.id = n.id;
    node.dataset.transient = String(transient === id);
    node.title = n.name + '.' + n.ext;
    node.setAttribute('aria-selected', String(current ? current.id === id : false));
    node.querySelector('.doc__icon').replaceChildren(noteIcon(n));
    node.querySelector('.doc__name').textContent = n.name;
    const unsaved = dirty && current && current.id === id;
    node.querySelector('.doc__dot').hidden = !unsaved;
    node.querySelector('.doc__close').hidden = unsaved;
  }
  moveInk();
}

function moveInk() {
  requestAnimationFrame(() => {
    const node = current ? tabEls.get(current.id) : null;
    if (!node || node.classList.contains('is-closing')) {
      el.ink.dataset.on = 'false';
      return;
    }
    el.ink.dataset.on = 'true';
    el.ink.style.width = node.offsetWidth + 'px';
    el.ink.style.transform = 'translateX(' + node.offsetLeft + 'px)';
    const left = node.offsetLeft, right = left + node.offsetWidth;
    if (left < el.strip.scrollLeft) el.strip.scrollTo({ left: left - 8, behavior: 'smooth' });
    else if (right > el.strip.scrollLeft + el.strip.clientWidth) {
      el.strip.scrollTo({ left: right - el.strip.clientWidth + 8, behavior: 'smooth' });
    }
  });
}
addEventListener('resize', moveInk);

function pinTab(id) {
  if (transient === id) { transient = null; renderTabs(); }
}

function closeTab(id) {
  const i = open.indexOf(id);
  if (i < 0) return;
  open.splice(i, 1);
  if (transient === id) transient = null;
  prefs.open = open;
  if (current && current.id === id) {
    const next = open[i] || open[i - 1];
    if (next) select(next); else closeNote();
  } else {
    renderTabs();
  }
}

function closeOthers(id) {
  open = open.filter(x => x === id);
  transient = null;
  prefs.open = open;
  if (!current || current.id !== id) select(id); else renderTabs();
}

/* ------------------------------------------------------------ the list */

function matches(n, q) {
  if (!q) return true;
  const hay = (n.name + ' ' + n.body).toLowerCase();
  return q.toLowerCase().split(/\s+/).every(w => hay.includes(w));
}

function renderList() {
  const items = notes
    .filter(n => n.trashed === (view === 'trash') && matches(n, query))
    .sort((a, b) => b.updated - a.updated);

  el.list.textContent = '';
  if (!items.length) {
    const d = document.createElement('div');
    d.className = 'sw__empty';
    d.textContent = query ? 'No notes match.'
      : view === 'trash' ? 'Trash is empty.'
      : 'No notes yet. Press Ctrl+N.';
    el.list.appendChild(d);
  }

  let group = '';
  for (const n of items) {
    const b = bucket(n.updated);
    if (b !== group) {
      group = b;
      const h = document.createElement('div');
      h.className = 'list__group'; h.textContent = b;
      el.list.appendChild(h);
    }

    const row = document.createElement('button');
    row.className = 'note'; row.type = 'button'; row.dataset.id = n.id;
    row.setAttribute('role', 'option');
    row.title = n.name + '.' + n.ext;
    const on = current && current.id === n.id;
    row.setAttribute('aria-current', String(!!on));
    row.setAttribute('aria-selected', String(!!on));
    row.dataset.open = String(open.includes(n.id));

    const ic = document.createElement('span'); ic.className = 'note__icon';
    ic.appendChild(noteIcon(n));

    const text = document.createElement('div'); text.className = 'note__text';
    const title = document.createElement('div');
    title.className = 'note__title'; title.textContent = n.name;
    const meta = document.createElement('div'); meta.className = 'note__meta';
    const when = document.createElement('span'); when.textContent = relative(n.updated);
    meta.appendChild(when);
    const snip = snippet(n);
    if (snip) {
      const dot = document.createElement('span'); dot.className = 'dot'; dot.textContent = '·';
      const s = document.createElement('span'); s.className = 'snip'; s.textContent = snip;
      meta.append(dot, s);
    }
    text.append(title, meta);

    const openDot = document.createElement('span'); openDot.className = 'note__open';
    row.append(ic, text, openDot);
    el.list.appendChild(row);
  }

  const live = notes.filter(n => !n.trashed).length;
  const binned = notes.length - live;
  el.count.textContent = (live === 1 ? '1 note' : live + ' notes')
    + (binned ? ' · ' + binned + ' in trash' : '');
}

el.list.addEventListener('click', e => {
  const b = e.target.closest('.note');
  if (b) select(b.dataset.id);
});
el.list.addEventListener('dblclick', e => {
  const b = e.target.closest('.note');
  if (b) pinTab(b.dataset.id);
});
el.list.addEventListener('contextmenu', e => {
  const b = e.target.closest('.note');
  if (!b) return;
  e.preventDefault();
  select(b.dataset.id);
  openMenu(e.clientX, e.clientY);
});

/* ------------------------------------------------------------ opening */

function paint() {
  const n = current;
  if (!n) {
    el.editor.hidden = true; el.preview.hidden = true; el.empty.hidden = false;
    el.state.textContent = '';
    for (const b of el.ext.children) b.setAttribute('aria-pressed', 'false');
    return;
  }
  el.empty.hidden = true;
  for (const b of el.ext.children) b.setAttribute('aria-pressed', String(b.dataset.ext === n.ext));
  if (n.ext === 'txt' && preview) preview = false;
  $('#togglePreview').setAttribute('aria-pressed', String(preview));
  el.editor.hidden = preview;
  el.preview.hidden = !preview;
  if (preview) renderPreview();
}

/** Play the body's entrance once, without leaving the class behind. */
function switchAnimation() {
  el.body.classList.remove('is-switching');
  void el.body.offsetWidth;
  el.body.classList.add('is-switching');
}

async function select(id, options) {
  const pin = options && options.pin;
  const n = byId(id);
  if (!n) return;
  if (current === n) { if (pin) pinTab(id); return; }
  await flush();

  if (!open.includes(id)) {
    if (!pin && transient && open.includes(transient)) {
      open[open.indexOf(transient)] = id;   // the transient tab gives way
    } else {
      open.push(id);
    }
    transient = pin ? null : id;
  } else if (pin) {
    transient = transient === id ? null : transient;
  }
  prefs.open = open;

  current = n;
  prefs.last = id;
  el.editor.value = n.body;
  paint();
  switchAnimation();
  if (!preview) el.editor.focus();
  setState('Saved ' + relative(n.updated));
  renderList(); renderTabs();
}

function closeNote() {
  current = null; prefs.last = '';
  el.editor.value = '';
  paint();
  renderList(); renderTabs();
}

async function create(name, ext, body) {
  await flush();
  try {
    const n = await invoke('create', {
      name: name || 'Untitled', ext: ext || 'md', body: body || '',
    });
    notes.push(n);
    if (view !== 'notes') { view = 'notes'; syncViewTabs(); }
    await select(n.id, { pin: true });
    el.editor.focus();
    return n;
  } catch (e) { failed(e, "Couldn't create the note."); }
}

function syncViewTabs() {
  for (const t of document.querySelectorAll('.side__tabs .tab')) {
    t.setAttribute('aria-selected', String(t.dataset.view === view));
  }
}

/* ------------------------------------------------------------ editing */

el.editor.addEventListener('input', () => {
  if (!current) return;
  current.body = el.editor.value;
  pinTab(current.id);     // typing in it means you meant to keep it
  touch();
});

el.editor.addEventListener('keydown', e => {
  if (e.key === 'Tab' && !e.shiftKey && current) {
    e.preventDefault();
    el.editor.setRangeText('\t', el.editor.selectionStart, el.editor.selectionEnd, 'end');
    current.body = el.editor.value;
    touch();
  }
});

/** Renaming moves a real file, so it is a decision, not a keystroke. */
async function renameNote(n) {
  const note = n || current;
  if (!note) return;
  const wanted = await promptDialog({
    title: 'Rename note',
    label: 'The file is renamed in the folder too.',
    value: note.name,
    confirm: 'Rename',
  });
  if (wanted === null || wanted.trim() === note.name) return;
  await applyRename(note, wanted.trim() || 'Untitled', note.ext);
}

async function applyRename(note, name, ext) {
  await flush();
  const was = note.id;
  try {
    const fresh = await invoke('rename', { id: was, name, ext });
    Object.assign(note, fresh);
    const i = open.indexOf(was);
    if (i >= 0) open[i] = note.id;
    if (transient === was) transient = note.id;
    const node = tabEls.get(was);
    if (node) { tabEls.delete(was); tabEls.set(note.id, node); }
    prefs.open = open;
    if (current === note) { prefs.last = note.id; paint(); }
    renderList(); renderTabs();
  } catch (e) { failed(e, "Couldn't rename the note."); }
}

el.ext.addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b || !current || b.dataset.ext === current.ext) return;
  if (b.dataset.ext === 'txt' && preview) togglePreview();
  applyRename(current, current.name, b.dataset.ext);
});

el.search.addEventListener('input', () => { query = el.search.value; renderList(); });
for (const t of document.querySelectorAll('.side__tabs .tab')) {
  t.addEventListener('click', () => { view = t.dataset.view; syncViewTabs(); renderList(); });
}

/* ------------------------------------------------------------ markdown */

const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img alt="$1" src="$2">')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" rel="noopener">$1</a>')
    .replace(/(\*\*|__)(\S(?:.*?\S)?)\1/g, '<strong>$2</strong>')
    .replace(/(^|[^\w*])\*(\S(?:[^*]*?\S)?)\*/g, '$1<em>$2</em>')
    .replace(/~~(\S(?:.*?\S)?)~~/g, '<del>$1</del>');
}

function md(src) {
  const out = [], lines = src.split('\n');
  let i = 0, para = [], listTag = null;
  const closeP = () => {
    if (para.length) { out.push('<p>' + inline(para.join('\n')).replace(/\n/g, '<br>') + '</p>'); para = []; }
  };
  const closeL = () => { if (listTag) { out.push('</' + listTag + '>'); listTag = null; } };
  const close = () => { closeP(); closeL(); };

  while (i < lines.length) {
    const l = lines[i];
    let m;

    if (/^\s*```/.test(l)) {
      close(); const buf = []; i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push('<pre><code>' + esc(buf.join('\n')) + '</code></pre>');
      continue;
    }
    if (!l.trim()) { close(); i++; continue; }
    if ((m = l.match(/^(#{1,6})\s+(.*)$/))) {
      close();
      out.push('<h' + m[1].length + '>' + inline(m[2]) + '</h' + m[1].length + '>');
      i++; continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { close(); out.push('<hr>'); i++; continue; }
    if (/^\s*>/.test(l)) {
      close(); const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push('<blockquote>' + md(buf.join('\n')) + '</blockquote>');
      continue;
    }
    if (/^\|/.test(l) && /^\s*\|?[\s:|-]*-[\s:|-]*$/.test(lines[i + 1] || '')) {
      close();
      const cells = r => r.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const head = cells(l); i += 2; const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push('<table><thead><tr>' + head.map(c => '<th>' + inline(c) + '</th>').join('')
        + '</tr></thead><tbody>'
        + rows.map(r => '<tr>' + r.map(c => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('')
        + '</tbody></table>');
      continue;
    }
    if ((m = l.match(/^\s*([-*+]|\d+[.)])\s+(.*)$/))) {
      const tag = /^\s*\d/.test(l) ? 'ol' : 'ul';
      closeP();
      if (listTag && listTag !== tag) closeL();
      if (!listTag) { listTag = tag; out.push('<' + tag + '>'); }
      const task = m[2].match(/^\[([ xX])\]\s+(.*)$/);
      out.push(task
        ? '<li><input type="checkbox" disabled' + (task[1] !== ' ' ? ' checked' : '') + '>' + inline(task[2]) + '</li>'
        : '<li>' + inline(m[2]) + '</li>');
      i++; continue;
    }
    closeL(); para.push(l); i++;
  }
  close();
  return out.join('\n');
}

function renderPreview() { el.preview.innerHTML = current ? md(current.body) : ''; }

function togglePreview() {
  if (!current) return;
  if (current.ext === 'txt' && !preview) {
    toast('Preview is for Markdown notes. This one is .txt.');
    return;
  }
  preview = !preview;
  paint();
  switchAnimation();
  if (!preview) el.editor.focus();
  announce(preview ? 'Preview shown' : 'Editor shown');
}
$('#togglePreview').onclick = togglePreview;

el.preview.addEventListener('click', e => {
  const a = e.target.closest('a');
  if (!a) return;
  e.preventDefault();
  if (/^https?:/i.test(a.href)) window.open(a.href, '_blank');
});

/* ------------------------------------------------------------ dialogs */

function overlay(build) {
  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  const box = document.createElement('div');
  box.className = 'dialog';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  scrim.appendChild(box);
  document.body.appendChild(scrim);
  return build(box, scrim);
}

function confirmDialog({ title, body, confirm: label }) {
  return new Promise(resolve => overlay((box, scrim) => {
    const h = document.createElement('h2');
    h.append(icon('alert', 16), document.createTextNode(title));
    const p = document.createElement('p'); p.textContent = body;
    const foot = document.createElement('div'); foot.className = 'dialog__foot';
    const cancel = document.createElement('button');
    cancel.className = 'btn'; cancel.textContent = 'Cancel';
    const go = document.createElement('button');
    go.className = 'btn danger'; go.textContent = label;
    foot.append(cancel, go);
    box.append(h, p, foot);

    const done = answer => {
      scrim.remove();
      document.removeEventListener('keydown', key, true);
      resolve(answer);
    };
    const key = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); } };
    document.addEventListener('keydown', key, true);
    cancel.onclick = () => done(false);
    go.onclick = () => done(true);
    scrim.onmousedown = e => { if (e.target === scrim) done(false); };
    cancel.focus();     // the safe answer
  }));
}

function promptDialog({ title, label, value, confirm: ok }) {
  return new Promise(resolve => overlay((box, scrim) => {
    const h = document.createElement('h2');
    h.append(icon('pencil', 16), document.createTextNode(title));
    const p = document.createElement('p'); p.textContent = label;
    const input = document.createElement('input');
    input.value = value || ''; input.spellcheck = false;
    input.setAttribute('aria-label', title);
    const foot = document.createElement('div'); foot.className = 'dialog__foot';
    const cancel = document.createElement('button');
    cancel.className = 'btn'; cancel.textContent = 'Cancel';
    const go = document.createElement('button');
    go.className = 'btn'; go.textContent = ok || 'Save';
    foot.append(cancel, go);
    box.append(h, p, input, foot);

    const done = answer => {
      scrim.remove();
      document.removeEventListener('keydown', key, true);
      resolve(answer);
    };
    const key = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); } };
    document.addEventListener('keydown', key, true);
    input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); done(input.value); } };
    cancel.onclick = () => done(null);
    go.onclick = () => done(input.value);
    scrim.onmousedown = e => { if (e.target === scrim) done(null); };
    input.focus(); input.select();
  }));
}

/* ------------------------------------------------------------ actions */

async function trashNote(n) {
  await flush();
  try {
    Object.assign(n, await invoke('trash', { id: n.id }));
    closeTab(n.id);
    renderList();
    toast('Moved ' + n.name + ' to trash', {
      label: 'Undo',
      async run() {
        try {
          Object.assign(n, await invoke('restore', { id: n.id }));
          select(n.id, { pin: true });
        } catch (e) { failed(e, "Couldn't restore the note."); }
      },
    });
  } catch (e) { failed(e, "Couldn't move the note to trash."); }
}

async function restoreNote(n) {
  try {
    Object.assign(n, await invoke('restore', { id: n.id }));
    renderList();
    toast('Restored ' + n.name);
  } catch (e) { failed(e, "Couldn't restore the note."); }
}

async function eraseNote(n) {
  const ok = await confirmDialog({
    title: 'Delete "' + n.name + '" for good?',
    body: 'The file leaves the folder for good. This cannot be undone.',
    confirm: 'Delete for good',
  });
  if (!ok) return;
  try {
    if (current === n) { dirty = false; shownDirty = false; clearTimeout(saveTimer); }
    await invoke('delete_forever', { id: n.id });
    notes = notes.filter(x => x !== n);
    closeTab(n.id);
    renderList();
    toast('Deleted for good');
  } catch (e) { failed(e, "Couldn't delete the note."); }
}

async function emptyTrash() {
  const count = notes.filter(n => n.trashed).length;
  if (!count) { toast('Trash is already empty.'); return; }
  const ok = await confirmDialog({
    title: 'Empty the trash?',
    body: (count === 1 ? '1 note' : count + ' notes')
      + ' leave the folder for good. This cannot be undone.',
    confirm: 'Empty trash',
  });
  if (!ok) return;
  try {
    const gone = await invoke('empty_trash');
    for (const n of notes.filter(x => x.trashed)) closeTab(n.id);
    notes = notes.filter(n => !n.trashed);
    renderList();
    toast('Emptied the trash · ' + (gone === 1 ? '1 note' : gone + ' notes'));
  } catch (e) { failed(e, "Couldn't empty the trash."); }
}

/* ------------------------------------------------------------ menu */

let menu = null;
const closeMenu = () => { if (menu) { menu.remove(); menu = null; } };
addEventListener('mousedown', e => { if (menu && !menu.contains(e.target)) closeMenu(); });
addEventListener('resize', closeMenu);

function openMenu(x, y) {
  closeMenu();
  if (!current) return;
  const n = current;
  const m = document.createElement('div');
  m.className = 'menu'; m.setAttribute('role', 'menu');

  const add = (name, label, kbd, run, cls) => {
    const b = document.createElement('button');
    b.type = 'button'; b.setAttribute('role', 'menuitem');
    if (cls) b.className = cls;
    b.append(icon(name, 14), document.createTextNode(label));
    if (kbd) { const k = document.createElement('kbd'); k.textContent = kbd; b.appendChild(k); }
    b.onclick = () => { closeMenu(); run(); };
    m.appendChild(b);
  };
  const rule = () => m.appendChild(document.createElement('hr'));

  add('pencil', 'Rename…', 'F2', () => renameNote(n));
  add('copy', 'Copy all', 'Ctrl+Shift+C', async () => {
    try { await navigator.clipboard.writeText(n.body); toast('Copied the note'); }
    catch (e) { failed(e, "Couldn't copy the note."); }
  });
  add('files', 'Duplicate', null, () => create(n.name + ' copy', n.ext, n.body));
  add('folder-open', 'Show in folder', null, async () => {
    try { await invoke('reveal', { id: n.id }); } catch (e) { failed(e, "Couldn't open the folder."); }
  });
  rule();
  if (open.length > 1 && open.includes(n.id)) {
    add('x', 'Close others', null, () => closeOthers(n.id));
    rule();
  }
  if (n.trashed) {
    add('restore', 'Restore', null, () => restoreNote(n));
    add('trash', 'Delete for good', null, () => eraseNote(n), 'danger');
    add('trash', 'Empty trash', null, emptyTrash, 'danger');
  } else {
    add('trash', 'Move to trash', 'Ctrl+Del', () => trashNote(n), 'danger');
  }

  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px';
  m.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
  menu = m;
  m.querySelector('button').focus();
}
$('#more').onclick = e => {
  const r = e.currentTarget.getBoundingClientRect();
  openMenu(r.right - 210, r.bottom + 4);
};

/* ------------------------------------------------------------ switcher */

let switcher = null;

function openSwitcher() {
  if (switcher) return;
  flush();
  const scrim = document.createElement('div'); scrim.className = 'scrim';
  const box = document.createElement('div'); box.className = 'sw';
  const head = document.createElement('div'); head.className = 'sw__head';
  const mark = document.createElement('span'); mark.appendChild(icon('search', 16));
  const input = document.createElement('input');
  input.placeholder = 'Jump to a note';
  input.setAttribute('aria-label', 'Jump to a note');
  input.spellcheck = false;
  head.append(mark, input);
  const list = document.createElement('div'); list.className = 'sw__list';
  box.append(head, list);
  scrim.appendChild(box);
  document.body.appendChild(scrim);
  switcher = scrim;

  let items = [], active = 0;
  const close = () => { scrim.remove(); switcher = null; };

  const draw = () => {
    const q = input.value.trim();
    items = notes.filter(n => !n.trashed && matches(n, q))
      .sort((a, b) => b.updated - a.updated).slice(0, 60);
    active = 0;
    list.textContent = '';
    if (!items.length) {
      const d = document.createElement('div'); d.className = 'sw__empty';
      d.textContent = q ? 'No notes match. Press Enter to create "' + q + '".' : 'No notes yet.';
      list.appendChild(d);
      return;
    }
    items.forEach((n, i) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'sw__item'; b.dataset.active = String(i === 0);
      const t = document.createElement('b'); t.textContent = n.name;
      const s = document.createElement('span'); s.textContent = snippet(n) || relative(n.updated);
      b.append(noteIcon(n), t, s);
      b.onclick = () => { close(); select(n.id, { pin: true }); };
      list.appendChild(b);
    });
  };

  const move = d => {
    if (!items.length) return;
    list.children[active].dataset.active = 'false';
    active = (active + d + items.length) % items.length;
    const c = list.children[active];
    c.dataset.active = 'true';
    c.scrollIntoView({ block: 'nearest' });
  };

  input.oninput = draw;
  input.onkeydown = e => {
    if (e.key === 'Escape') { e.preventDefault(); close(); el.editor.focus(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (items.length) { const id = items[active].id; close(); select(id, { pin: true }); }
      else { const q = input.value.trim(); close(); create(q); }
    }
  };
  scrim.onmousedown = e => { if (e.target === scrim) close(); };
  draw();
  input.focus();
}

/* ------------------------------------------------------------ folder */

function shortFolder(p) {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.slice(-2).join(' / ') || p;
}

async function chooseFolder() {
  let picked;
  try {
    picked = await dialog.open({
      directory: true, multiple: false, title: 'Choose a notes folder', defaultPath: root,
    });
  } catch (e) { return failed(e, "Couldn't open the folder picker."); }
  if (!picked) return;
  try {
    await flush();
    open = []; transient = null; prefs.open = open;
    for (const [, node] of tabEls) node.remove();
    tabEls.clear();
    adopt(await invoke('set_root', { path: picked }));
    toast('Notes folder: ' + shortFolder(root));
  } catch (e) { failed(e, "Couldn't use that folder."); }
}
$('#folder').onclick = chooseFolder;
$('#reveal').onclick = async () => {
  try { await invoke('reveal', { id: null }); } catch (e) { failed(e, "Couldn't open the folder."); }
};

async function importPaths(paths) {
  try {
    const made = await invoke('import', { paths });
    if (!made.length) { toast('Nothing to import. Notepad takes .md and .txt files.'); return; }
    notes.push(...made);
    renderList();
    toast('Imported ' + (made.length === 1 ? made[0].name : made.length + ' files'));
    if (made.length === 1) select(made[0].id, { pin: true });
  } catch (e) { failed(e, "Couldn't import those files."); }
}

/* ------------------------------------------------------------ theme */

function applyTheme() {
  const t = prefs.theme;
  document.documentElement.dataset.theme = t;
  const btn = $('#theme');
  btn.replaceChildren(icon({ auto: 'monitor', light: 'sun', dark: 'moon' }[t], 14));
  btn.title = 'Theme: ' + t + '. Click to switch.';
}
$('#theme').onclick = () => {
  prefs.theme = { auto: 'light', light: 'dark', dark: 'auto' }[prefs.theme];
  applyTheme();
  announce('Theme: ' + prefs.theme);
};

function applySide() { el.app.dataset.side = prefs.side === 'hidden' ? 'hidden' : 'shown'; }
$('#toggleSide').onclick = () => {
  prefs.side = prefs.side === 'hidden' ? 'shown' : 'hidden';
  applySide();
  $('#toggleSide').title = (prefs.side === 'hidden' ? 'Show' : 'Hide') + ' the list   Ctrl+\\';
  setTimeout(moveInk, 240);
};
$('#new').onclick = () => create();
$('#newTab').onclick = () => create();

/* ------------------------------------------------------------ keyboard */

addEventListener('keydown', e => {
  if (e.key === 'Escape' && menu) { closeMenu(); return; }
  if (e.key === 'F2' && current) { e.preventDefault(); renameNote(); return; }
  if (!(e.ctrlKey || e.metaKey)) return;
  const k = e.key.toLowerCase();

  if (e.key === 'Tab') {
    e.preventDefault();
    if (open.length < 2) return;
    const i = current ? open.indexOf(current.id) : -1;
    select(open[(i + (e.shiftKey ? -1 : 1) + open.length) % open.length], { pin: false });
  }
  else if (k === 'n' && !e.shiftKey) { e.preventDefault(); create(); }
  else if (k === 'w') { e.preventDefault(); if (current) closeTab(current.id); }
  else if (k === 'k' || (k === 'p' && !e.shiftKey)) { e.preventDefault(); openSwitcher(); }
  else if (k === 's') { e.preventDefault(); flush(); }
  else if (k === 'e') { e.preventDefault(); togglePreview(); }
  else if (k === 'f') { e.preventDefault(); el.search.focus(); el.search.select(); }
  else if (k === '\\') { e.preventDefault(); $('#toggleSide').click(); }
  else if (k === 'c' && e.shiftKey && current) {
    e.preventDefault();
    navigator.clipboard.writeText(current.body).then(() => toast('Copied the note'));
  }
  else if (e.key >= '1' && e.key <= '9') {
    e.preventDefault();
    const i = e.key === '9' ? open.length - 1 : Number(e.key) - 1;
    if (open[i]) select(open[i]);
  }
  else if (e.key === 'Delete' && current && !current.trashed) {
    e.preventDefault(); trashNote(current);
  }
});

/* ------------------------------------------------------------ start */

function adopt(loaded) {
  root = loaded.root;
  notes = loaded.notes;
  el.folderName.textContent = shortFolder(root);
  $('#folder').title = root + '\nClick to change the notes folder';
  current = null;

  open = prefs.open.filter(id => { const n = byId(id); return n && !n.trashed; });
  prefs.open = open;
  renderList(); renderTabs();

  const last = byId(prefs.last);
  if (last && !last.trashed) select(last.id, { pin: true });
  else if (open.length) select(open[0], { pin: true });
  else {
    const live = notes.filter(n => !n.trashed).sort((a, b) => b.updated - a.updated);
    if (live.length) select(live[0].id, { pin: true }); else closeNote();
  }
}

/* The folder changed under us - another editor, a sync client, a rename. */
listen('notes:changed', event => {
  const openId = current && current.id;
  const mine = current && dirty ? current.body : null;

  notes = event.payload;
  open = open.filter(id => { const n = byId(id); return n && !n.trashed; });
  prefs.open = open;

  const still = openId ? byId(openId) : null;
  if (still) {
    current = still;
    if (mine !== null) {
      current.body = mine;               // yours wins while you are mid-edit
    } else if (el.editor.value !== current.body) {
      const at = Math.min(el.editor.selectionStart, current.body.length);
      el.editor.value = current.body;
      el.editor.setSelectionRange(at, at);
      if (preview) renderPreview();
      setState('Reloaded from disk');
    }
    paint();
  } else if (openId) {
    closeNote();
    toast('That note is no longer in the folder.');
  }
  renderList(); renderTabs();
});

listen('tauri://drag-drop', event => {
  const paths = (event.payload && event.payload.paths) || [];
  if (paths.length) importPaths(paths);
});

(async () => {
  hydrateIcons();
  applyTheme();
  applySide();
  syncViewTabs();
  try {
    adopt(await invoke('load'));
  } catch (e) {
    failed(e, "Couldn't open your notes folder.");
    return;
  }
  if (!notes.length) {
    await create('Read me', 'md',
      '# Notepad\n\n'
      + 'Every note here is a real file in the folder shown at the bottom left.\n'
      + 'Nothing leaves this computer.\n\n'
      + '## Keys\n\n'
      + '- Ctrl+N  new note\n'
      + '- Ctrl+K  jump to any note\n'
      + '- Ctrl+W  close the tab\n'
      + '- Ctrl+Tab  next tab, Ctrl+1 to Ctrl+9 for one by number\n'
      + '- Ctrl+E  Markdown preview\n'
      + '- Ctrl+F  search\n'
      + '- F2  rename\n'
      + '- Ctrl+\\  hide the list\n'
      + '- Ctrl+Delete  move to trash\n\n'
      + '## Tabs\n\n'
      + 'One click opens a note in an italic tab that the next click reuses.\n'
      + 'Type in it, double-click it, or open it from Ctrl+K to keep it.\n\n'
      + 'Drop .md or .txt files on the window to bring them in. Edit a file in\n'
      + 'another editor and it updates here straight away.\n\n'
      + 'Delete this when you are done with it.\n');
  }
  setInterval(renderList, 60000);   // keep "2m ago" honest
})();

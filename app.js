import * as T from './tree.js';
import { CONFIG } from './config.js';

const tg = window.Telegram?.WebApp;
try { tg?.ready(); tg?.expand(); } catch { /* вне Telegram */ }

// Демо: нет адреса API, открыто вне Telegram или добавлен ?demo=1
const DEMO = !CONFIG.API_URL || new URLSearchParams(location.search).has('demo') || !tg?.initData;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'n_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
const haptic = (t = 'light') => { try { tg?.HapticFeedback?.impactOccurred(t); } catch { /* noop */ } };
const collator = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });
const byName = (a, b) => collator.compare(a.name, b.name);

let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

/* ====================== Хранилища ====================== */

// --- Демо: всё в localStorage, логика та же, что на сервере (tree.js)
const LOCAL_KEY = 'saved_cloud_demo_v2';

function seedDemo() {
  const now = Date.now();
  const day = 86400000;
  const base = { kind: null, mime: null, size: null, tg_chat_id: null, tg_message_id: null, file_id: null, created_at: now, updated_at: now, deleted_at: null };
  const folder = (id, parent_id, name) => ({ ...base, id, parent_id, type: 'folder', name });
  const file = (id, parent_id, name, size, ago, kind = 'document') => ({ ...base, id, parent_id, type: 'file', name, size, kind, created_at: now - ago * day });
  return [
    folder('d_docs', null, 'Документы'),
    folder('d_work', null, 'Работа'),
    folder('d_rep', 'd_work', 'Отчёты'),
    folder('d_2026', 'd_rep', '2026'),
    folder('inbox', null, 'Входящие'),
    file('f1', 'd_docs', 'Скан_паспорта.pdf', 2200000, 12),
    file('f2', 'd_2026', 'Накладная_412.xlsx', 491520, 3),
    file('f3', 'inbox', 'Фото 2026-11-19 02-40.jpg', 1843200, 0, 'photo'),
    file('f4', 'inbox', 'Договор.docx', 96000, 1),
  ];
}

function localLoad() {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (raw) { const d = JSON.parse(raw); if (Array.isArray(d)) return d; }
  } catch { /* повреждённые данные -> начинаем заново */ }
  return seedDemo();
}
function localSave(nodes) { try { localStorage.setItem(LOCAL_KEY, JSON.stringify(nodes)); } catch { /* квота */ } }
function localOp(fn) { const nodes = localLoad(); fn(nodes); localSave(nodes); }

const LocalApi = {
  async list() { return localLoad(); },
  async createFolder(parent_id, name) { localOp((n) => T.createFolder(n, { parent_id, name }, Date.now(), uid())); },
  async update(id, patch) { localOp((n) => T.updateNode(n, id, patch, Date.now())); },
  async remove(id) { localOp((n) => T.softDelete(n, id, Date.now())); },
  async restore(id) { localOp((n) => T.restore(n, id, Date.now())); },
  async emptyTrash() { localOp((n) => T.purgeTrash(n)); },
  async send() { throw new T.TreeError('В демо-режиме недоступно'); },
  // имитация: «в канал пришёл новый файл»
  async addTestFile() {
    localOp((n) => {
      const inbox = n.find((x) => x.id === 'inbox');
      if (!inbox) T.createFolder(n, { parent_id: null, name: 'Входящие' }, Date.now(), 'inbox');
      else if (inbox.deleted_at) T.restore(n, 'inbox', Date.now());
      const t = new Date().toLocaleTimeString('ru-RU').replace(/:/g, '-');
      T.createFile(n, { parent_id: 'inbox', name: `Файл ${t}.pdf`, kind: 'document', size: Math.floor(Math.random() * 5e6) + 1e4 }, Date.now(), uid());
    });
  },
};

// --- Боевой режим: запросы к Cloudflare Worker, авторизация по подписанным initData
async function call(method, path, body) {
  const res = await fetch(CONFIG.API_URL.replace(/\/$/, '') + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'tma ' + tg.initData },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* пустой ответ */ }
  if (!res.ok) throw new Error(data?.error || `Ошибка ${res.status}`);
  return data;
}

const RemoteApi = {
  async list() { return (await call('GET', '/api/nodes')).nodes; },
  createFolder: (parent_id, name) => call('POST', '/api/folders', { parent_id, name }),
  update: (id, patch) => call('PATCH', `/api/nodes/${id}`, patch),
  remove: (id) => call('DELETE', `/api/nodes/${id}`),
  restore: (id) => call('POST', `/api/nodes/${id}/restore`),
  emptyTrash: () => call('POST', '/api/trash/empty'),
  send: (id) => call('POST', `/api/nodes/${id}/send`),
};

const Api = DEMO ? LocalApi : RemoteApi;

/* ====================== Состояние ====================== */

const SORTS = [
  { label: 'Имя ↑', key: 'name', dir: 1 },
  { label: 'Имя ↓', key: 'name', dir: -1 },
  { label: 'Сначала новые', key: 'date', dir: -1 },
  { label: 'Сначала старые', key: 'date', dir: 1 },
  { label: 'Размер ↓', key: 'size', dir: -1 },
];

const S = { nodes: [], cwd: null, view: 'files', query: '', sortIdx: 0, select: false, sel: new Set(), error: '' };

const FOLDER_SVG = '<svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>';

function extLabel(n) {
  const ext = T.splitExt(n.name)[1].slice(1);
  return (ext || n.kind || 'file').slice(0, 4).toUpperCase();
}

function sortFiles(arr) {
  const { key, dir } = SORTS[S.sortIdx];
  return arr.slice().sort((a, b) => {
    if (key === 'name') return dir * byName(a, b);
    const va = key === 'date' ? a.created_at : (a.size ?? 0);
    const vb = key === 'date' ? b.created_at : (b.size ?? 0);
    return dir * (va - vb) || byName(a, b);
  });
}

/* ====================== Отрисовка ====================== */

function render() {
  const by = new Map(S.nodes.map((n) => [n.id, n]));
  const live = S.nodes.filter((n) => !n.deleted_at);
  if (S.cwd && (!by.get(S.cwd) || by.get(S.cwd).deleted_at)) S.cwd = null;
  const cwdNode = S.cwd ? by.get(S.cwd) : null;
  const q = S.query.trim().toLowerCase();
  const inTrash = S.view === 'trash';

  $('title').textContent = inTrash ? 'Корзина' : q ? 'Поиск' : (cwdNode ? cwdNode.name : 'Мои файлы');
  const canBack = inTrash || (!q && !!S.cwd);
  $('backBtn').hidden = !canBack;
  try { canBack ? tg?.BackButton?.show() : tg?.BackButton?.hide(); } catch { /* noop */ }

  const badge = $('modeBadge');
  badge.textContent = DEMO ? 'Демо' : 'Онлайн';
  badge.className = 'badge' + (DEMO ? ' demo' : '');

  // хлебные крошки
  const crumbs = $('crumbs');
  if (inTrash || q) {
    crumbs.innerHTML = '';
  } else {
    const path = [];
    for (let c = cwdNode; c; c = c.parent_id ? by.get(c.parent_id) : null) path.unshift(c);
    crumbs.innerHTML = `<span class="crumb${path.length ? '' : ' last'}" data-id="">Мои файлы</span>` +
      path.map((f, i) => `<span>/</span><span class="crumb${i === path.length - 1 ? ' last' : ''}" data-id="${esc(f.id)}">${esc(f.name)}</span>`).join('');
  }

  // панель инструментов
  $('sortBtn').textContent = SORTS[S.sortIdx].label;
  $('selectBtn').classList.toggle('on', S.select);
  $('selectBtn').textContent = S.select ? 'Готово' : 'Выбрать';
  const trashCount = T.trashRoots(S.nodes).length;
  $('trashBtn').classList.toggle('on', inTrash);
  $('trashBtn').textContent = inTrash ? 'Файлы' : `Корзина${trashCount ? ` (${trashCount})` : ''}`;
  $('selectBtn').hidden = inTrash;
  $('sortBtn').hidden = inTrash;

  // содержимое
  const childCount = new Map();
  for (const n of live) childCount.set(n.parent_id ?? null, (childCount.get(n.parent_id ?? null) || 0) + 1);

  let items;
  if (inTrash) items = T.trashRoots(S.nodes);
  else if (q) items = live.filter((n) => n.name.toLowerCase().includes(q));
  else items = live.filter((n) => (n.parent_id ?? null) === S.cwd);

  const folders = items.filter((n) => n.type === 'folder').sort(byName);
  const files = sortFiles(items.filter((n) => n.type === 'file'));

  const row = (n) => {
    const checked = S.sel.has(n.id);
    let meta;
    if (inTrash) meta = `Удалено ${new Date(n.deleted_at).toLocaleDateString('ru-RU')}`;
    else if (n.type === 'folder') meta = `${childCount.get(n.id) || 0} эл.`;
    else meta = [T.formatBytes(n.size), new Date(n.created_at).toLocaleDateString('ru-RU')].filter(Boolean).join(' · ');
    if (q) meta = `${esc(T.pathOf(S.nodes, n.parent_id).join(' / ') || 'Корень')} · ${meta}`;
    return `<div class="row${checked ? ' sel' : ''}" data-act="tap" data-id="${esc(n.id)}">
      ${S.select ? `<span class="check${checked ? ' on' : ''}"></span>` : ''}
      <div class="ico ${n.type}">${n.type === 'folder' ? FOLDER_SVG : esc(extLabel(n))}</div>
      <div class="info"><div class="name">${esc(n.name)}</div><div class="meta">${meta}</div></div>
      ${S.select ? '' : `<button class="more" data-act="menu" data-id="${esc(n.id)}" aria-label="Меню">⋮</button>`}
    </div>`;
  };

  let html = '';
  if (S.error) {
    html = `<div class="empty"><b>Не удалось загрузить</b>${esc(S.error)}</div>`;
  } else if (!folders.length && !files.length) {
    html = inTrash ? '<div class="empty"><b>Корзина пуста</b>Удалённые элементы появятся здесь.</div>'
      : q ? '<div class="empty"><b>Ничего не найдено</b>Попробуйте другое название.</div>'
      : '<div class="empty"><b>Здесь пусто</b>Создайте папку или перенесите сюда файлы из «Входящих».</div>';
  } else {
    if (folders.length) html += `<div class="label">Папки</div><div class="list">${folders.map(row).join('')}</div>`;
    if (files.length) html += `<div class="label">Файлы</div><div class="list">${files.map(row).join('')}</div>`;
  }
  $('content').innerHTML = html;

  renderBottom(inTrash, q, trashCount);
}

function renderBottom(inTrash, q, trashCount) {
  const bar = $('bottomBar');
  if (S.select) {
    const none = S.sel.size === 0 ? 'disabled' : '';
    bar.innerHTML = `<span class="sel-count">Выбрано: ${S.sel.size}</span>
      <button class="btn" data-act="bulkMove" ${none}>Переместить</button>
      <button class="btn danger" data-act="bulkDelete" ${none}>Удалить</button>`;
  } else if (inTrash) {
    bar.innerHTML = `<button class="btn danger" data-act="emptyTrash" ${trashCount ? '' : 'disabled'}>Очистить корзину</button>`;
  } else {
    bar.innerHTML = `${q ? '' : '<button class="btn pri" data-act="newFolder">+ Новая папка</button>'}
      <button class="btn" data-act="howTo">Как добавить?</button>
      ${DEMO ? '<button class="btn" data-act="testFile">+ Тест-файл</button>' : ''}`;
  }
}

/* ====================== Диалоги ====================== */

function sheet(html, bind) {
  return new Promise((resolve) => {
    const body = $('sheet');
    const backdrop = $('backdrop');
    body.innerHTML = html;
    backdrop.classList.add('open');
    const close = (v) => { backdrop.classList.remove('open'); backdrop.onclick = null; resolve(v); };
    backdrop.onclick = (e) => { if (e.target === backdrop) close(undefined); };
    bind(body, close);
  });
}

function promptName(title, value, okLabel = 'Сохранить') {
  return sheet(
    `<div class="s-title">${esc(title)}</div>
     <input id="pInput" class="input" maxlength="120" value="${esc(value)}" autocomplete="off" />
     <div class="s-actions"><button class="btn" data-k="no">Отмена</button><button class="btn pri" data-k="ok">${esc(okLabel)}</button></div>`,
    (b, close) => {
      const inp = b.querySelector('#pInput');
      setTimeout(() => { inp.focus(); inp.select(); }, 80);
      const done = () => close(inp.value.trim() || undefined);
      b.querySelector('[data-k="ok"]').onclick = done;
      b.querySelector('[data-k="no"]').onclick = () => close(undefined);
      inp.onkeydown = (e) => { if (e.key === 'Enter') done(); };
    });
}

async function confirmBox(title, text, okLabel, danger = true) {
  const r = await sheet(
    `<div class="s-title">${esc(title)}</div><div class="s-sub">${esc(text)}</div>
     <div class="s-actions"><button class="btn" data-k="no">Отмена</button><button class="btn ${danger ? 'danger' : 'pri'}" data-k="ok">${esc(okLabel)}</button></div>`,
    (b, close) => b.querySelectorAll('[data-k]').forEach((x) => { x.onclick = () => close(x.dataset.k === 'ok'); }));
  return r === true;
}

function info(title, text) {
  return sheet(`<div class="s-title">${esc(title)}</div><div class="s-sub">${esc(text)}</div>
    <div class="s-actions"><button class="btn pri" data-k="ok">Понятно</button></div>`,
  (b, close) => { b.querySelector('[data-k]').onclick = () => close(true); });
}

// Выбор папки назначения. Возвращает id, null (корень) или undefined (отмена).
function pickFolder(excludeIds, title) {
  const live = S.nodes.filter((n) => !n.deleted_at && n.type === 'folder');
  const idx = T.childrenIndex(live);
  const rows = [{ id: '', name: 'Мои файлы (корень)', depth: 0 }];
  const walk = (pid, depth) => {
    for (const f of (idx.get(pid) || []).slice().sort(byName)) {
      if (excludeIds.has(f.id)) continue; // саму папку и её потомков не показываем
      rows.push({ id: f.id, name: f.name, depth });
      walk(f.id, depth + 1);
    }
  };
  walk(null, 1);
  return sheet(
    `<div class="s-title">${esc(title)}</div>
     ${rows.map((r) => `<button class="pick" data-id="${esc(r.id)}" style="padding-left:${14 + r.depth * 18}px">📁 ${esc(r.name)}</button>`).join('')}
     <div class="s-actions"><button class="btn" data-k="no">Отмена</button></div>`,
    (b, close) => {
      b.querySelectorAll('.pick').forEach((p) => { p.onclick = () => close(p.dataset.id === '' ? null : p.dataset.id); });
      b.querySelector('[data-k="no"]').onclick = () => close(undefined);
    });
}

/* ====================== Действия ====================== */

async function reload() {
  try {
    S.nodes = await Api.list();
    S.error = '';
  } catch (e) {
    S.error = e.message || 'Нет связи с сервером';
  }
  // мультивыбор: убираем то, чего уже нет
  const ids = new Set(S.nodes.filter((n) => !n.deleted_at).map((n) => n.id));
  for (const id of [...S.sel]) if (!ids.has(id)) S.sel.delete(id);
  render();
}

async function run(fn, okMsg) {
  try {
    await fn();
    if (okMsg) toast(okMsg);
    haptic('medium');
  } catch (e) {
    toast(e.message || 'Ошибка');
  }
  await reload();
}

function openFile(n) {
  const link = T.messageLink(n);
  if (!link) { toast(DEMO ? 'В демо-режиме файла в Telegram нет' : 'Нет ссылки на сообщение'); return; }
  if (tg?.openTelegramLink) tg.openTelegramLink(link);
  else window.open(link, '_blank');
}

function shareInline(n) {
  if (DEMO) { toast('В демо-режиме недоступно'); return; }
  if (!tg?.switchInlineQuery) { toast('Обновите Telegram, чтобы делиться файлами'); return; }
  try { tg.switchInlineQuery('f' + n.id, ['users', 'groups']); } catch { toast('Не удалось открыть выбор чата'); }
}

function leaveSelect() { S.select = false; S.sel.clear(); }

function goBack() {
  if (S.view === 'trash') { S.view = 'files'; render(); return; }
  const cur = S.nodes.find((n) => n.id === S.cwd);
  S.cwd = cur ? cur.parent_id ?? null : null;
  render();
}

async function doMove(ids) {
  const nodes = ids.map((id) => S.nodes.find((n) => n.id === id)).filter(Boolean);
  const excl = new Set(nodes.filter((n) => n.type === 'folder').map((n) => n.id));
  const target = await pickFolder(excl, nodes.length === 1 ? `Переместить «${nodes[0].name}»` : `Переместить: ${nodes.length}`);
  if (target === undefined) return;
  await run(async () => { for (const n of nodes) await Api.update(n.id, { parent_id: target }); }, 'Перемещено');
  leaveSelect();
  render();
}

async function doDelete(ids) {
  const nodes = ids.map((id) => S.nodes.find((n) => n.id === id)).filter(Boolean);
  const title = nodes.length === 1 ? `Удалить «${nodes[0].name}»?` : `Удалить выбранное (${nodes.length})?`;
  const ok = await confirmBox(title, 'Элементы уйдут в корзину каталога. Сами файлы останутся в Telegram.', 'Удалить');
  if (!ok) return;
  await run(async () => { for (const n of nodes) await Api.remove(n.id); }, 'Перемещено в корзину');
  leaveSelect();
  render();
}

async function openMenu(id) {
  const n = S.nodes.find((x) => x.id === id);
  if (!n) return;
  let items;
  if (S.view === 'trash') {
    items = [['restore', 'Восстановить']];
  } else if (n.type === 'folder') {
    items = [['open', 'Открыть'], ['rename', 'Переименовать'], ['move', 'Переместить…'], ['delete', 'Удалить', 'danger']];
  } else {
    items = [['view', 'Открыть в Telegram'], ['share', 'Поделиться…'], ['send', 'Отправить мне в чат с ботом'],
      ['rename', 'Переименовать'], ['move', 'Переместить…'], ['delete', 'Удалить', 'danger']];
  }
  const sub = [T.pathOf(S.nodes, n.parent_id).join(' / ') || 'Корень', n.type === 'file' ? T.formatBytes(n.size) : ''].filter(Boolean).join(' · ');
  const action = await sheet(
    `<div class="s-title">${esc(n.name)}</div><div class="s-sub">${esc(sub)}</div>
     <div class="menu">${items.map(([k, label, cls]) => `<button class="${cls || ''}" data-k="${k}">${esc(label)}</button>`).join('')}</div>`,
    (b, close) => b.querySelectorAll('[data-k]').forEach((x) => { x.onclick = () => close(x.dataset.k); }));

  switch (action) {
    case 'open': S.query = ''; $('search').value = ''; S.cwd = n.id; render(); break;
    case 'view': openFile(n); break;
    case 'share': shareInline(n); break;
    case 'send': await run(() => Api.send(n.id), 'Отправлено в чат с ботом'); break;
    case 'rename': {
      const name = await promptName('Переименовать', n.name);
      if (name !== undefined && name !== n.name) await run(() => Api.update(n.id, { name }), 'Переименовано');
      break;
    }
    case 'move': await doMove([n.id]); break;
    case 'delete': await doDelete([n.id]); break;
    case 'restore': await run(() => Api.restore(n.id), 'Восстановлено'); break;
    default: break;
  }
}

/* ====================== События ====================== */

$('content').addEventListener('click', (e) => {
  const menuBtn = e.target.closest('[data-act="menu"]');
  if (menuBtn) { haptic(); openMenu(menuBtn.dataset.id); return; }
  const rowEl = e.target.closest('[data-act="tap"]');
  if (!rowEl) return;
  const n = S.nodes.find((x) => x.id === rowEl.dataset.id);
  if (!n) return;
  haptic();
  if (S.select) {
    S.sel.has(n.id) ? S.sel.delete(n.id) : S.sel.add(n.id);
    render();
  } else if (S.view === 'trash') {
    openMenu(n.id);
  } else if (n.type === 'folder') {
    S.query = ''; $('search').value = ''; S.cwd = n.id; render();
    window.scrollTo(0, 0);
  } else {
    openFile(n);
  }
});

$('crumbs').addEventListener('click', (e) => {
  const c = e.target.closest('.crumb');
  if (!c) return;
  S.cwd = c.dataset.id || null;
  render();
});

$('bottomBar').addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  haptic();
  switch (act) {
    case 'newFolder': {
      const name = await promptName('Новая папка', '', 'Создать');
      if (name !== undefined) await run(() => Api.createFolder(S.cwd, name), 'Папка создана');
      break;
    }
    case 'howTo':
      await info('Как добавить файлы', DEMO
        ? 'В рабочем режиме вы отправляете файл в свой канал-хранилище, а бот сам кладёт его в папку «Входящие». Здесь, в демо, это имитирует кнопка «+ Тест-файл».'
        : 'Отправьте файл в ваш канал-хранилище в Telegram. Бот добавит его в папку «Входящие», а здесь вы разложите файлы по папкам.');
      break;
    case 'testFile': await run(() => Api.addTestFile(), 'Файл добавлен во «Входящие»'); break;
    case 'bulkMove': await doMove([...S.sel]); break;
    case 'bulkDelete': await doDelete([...S.sel]); break;
    case 'emptyTrash': {
      const ok = await confirmBox('Очистить корзину?', 'Записи исчезнут из каталога навсегда. Файлы в Telegram останутся.', 'Очистить');
      if (ok) await run(() => Api.emptyTrash(), 'Корзина очищена');
      break;
    }
    default: break;
  }
});

$('backBtn').addEventListener('click', goBack);
try { tg?.BackButton?.onClick(goBack); } catch { /* noop */ }

$('search').addEventListener('input', (e) => { S.query = e.target.value; render(); });
$('sortBtn').addEventListener('click', () => { S.sortIdx = (S.sortIdx + 1) % SORTS.length; render(); });
$('selectBtn').addEventListener('click', () => { S.select ? leaveSelect() : (S.select = true); render(); });
$('trashBtn').addEventListener('click', () => { leaveSelect(); S.view = S.view === 'trash' ? 'files' : 'trash'; render(); });

reload();

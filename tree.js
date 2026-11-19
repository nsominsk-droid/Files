// Общая логика дерева папок и файлов.
// Используется и фронтендом (демо-режим), и Cloudflare Worker — поэтому без зависимостей.
// Все функции работают над массивом узлов и мутируют его; возвращают изменённые узлы.

export class TreeError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'TreeError';
    this.status = status;
  }
}

const norm = (v) => (v === undefined || v === '' ? null : v);
const find = (nodes, id) => nodes.find((n) => n.id === id);

export function sanitizeName(raw) {
  let n = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\/\\]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  if (n.length > 120) n = n.slice(0, 120).trim();
  if (!n || n === '.' || n === '..') throw new TreeError('Некорректное имя');
  return n;
}

export function splitExt(name) {
  const i = name.lastIndexOf('.');
  if (i <= 0 || i === name.length - 1 || name.length - i > 9) return [name, ''];
  return [name.slice(0, i), name.slice(i)];
}

// «Отчёт.pdf» -> «Отчёт (2).pdf», если имя занято (регистр не учитывается, как в Windows)
export function uniqueName(name, type, taken) {
  if (!taken.has(name.toLowerCase())) return name;
  const [base, ext] = type === 'file' ? splitExt(name) : [name, ''];
  for (let i = 2; ; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

export function childrenIndex(nodes) {
  const m = new Map();
  for (const n of nodes) {
    const k = norm(n.parent_id);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(n);
  }
  return m;
}

export function takenNames(nodes, parentId, excludeId = null) {
  const s = new Set();
  const p = norm(parentId);
  for (const n of nodes) {
    if (!n.deleted_at && n.id !== excludeId && norm(n.parent_id) === p) s.add(n.name.toLowerCase());
  }
  return s;
}

// Все потомки узла (включая удалённых). Защита от циклов в повреждённых данных.
export function descendants(nodes, id) {
  const idx = childrenIndex(nodes);
  const out = [];
  const seen = new Set([id]);
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop();
    for (const c of idx.get(cur) || []) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c);
      stack.push(c.id);
    }
  }
  return out;
}

function requireFolder(nodes, parentId) {
  const p = norm(parentId);
  if (p === null) return null;
  const f = find(nodes, p);
  if (!f || f.type !== 'folder' || f.deleted_at) throw new TreeError('Папка назначения не найдена', 404);
  return f;
}

export function createFolder(nodes, { parent_id, name }, now, id) {
  requireFolder(nodes, parent_id);
  const clean = sanitizeName(name);
  if (takenNames(nodes, parent_id).has(clean.toLowerCase())) {
    throw new TreeError('Элемент с таким именем уже существует', 409);
  }
  const node = {
    id, parent_id: norm(parent_id), type: 'folder', name: clean,
    kind: null, mime: null, size: null, tg_chat_id: null, tg_message_id: null, file_id: null,
    created_at: now, updated_at: now, deleted_at: null,
  };
  nodes.push(node);
  return node;
}

export function createFile(nodes, f, now, id) {
  requireFolder(nodes, f.parent_id);
  const name = uniqueName(sanitizeName(f.name), 'file', takenNames(nodes, f.parent_id));
  const node = {
    id, parent_id: norm(f.parent_id), type: 'file', name,
    kind: f.kind ?? null, mime: f.mime ?? null, size: f.size ?? null,
    tg_chat_id: f.tg_chat_id ?? null, tg_message_id: f.tg_message_id ?? null, file_id: f.file_id ?? null,
    created_at: f.created_at ?? now, updated_at: now, deleted_at: null,
  };
  nodes.push(node);
  return node;
}

// Переименование и/или перенос. patch: { name?, parent_id? }
export function updateNode(nodes, id, patch, now) {
  const node = find(nodes, id);
  if (!node) throw new TreeError('Не найдено', 404);
  if (node.deleted_at) throw new TreeError('Элемент находится в корзине', 409);
  const hasParent = 'parent_id' in patch;
  const hasName = 'name' in patch;
  if (!hasParent && !hasName) throw new TreeError('Нечего менять');

  const target = hasParent ? norm(patch.parent_id) : norm(node.parent_id);
  const moved = target !== norm(node.parent_id);

  if (moved) {
    requireFolder(nodes, target);
    if (node.type === 'folder' && target !== null) {
      if (target === node.id || descendants(nodes, node.id).some((d) => d.id === target)) {
        throw new TreeError('Нельзя переместить папку в саму себя или в её подпапку');
      }
    }
  }

  const taken = takenNames(nodes, target, node.id);
  let name = node.name;
  if (hasName) {
    name = sanitizeName(patch.name);
    if (taken.has(name.toLowerCase())) throw new TreeError('Элемент с таким именем уже существует', 409);
  } else if (moved) {
    name = uniqueName(node.name, node.type, taken); // при переносе конфликт разрешаем автоматически
  }

  node.parent_id = target;
  node.name = name;
  node.updated_at = now;
  return [node];
}

// Мягкое удаление: папка и всё внутри получают одну метку времени (по ней потом восстанавливаем группу)
export function softDelete(nodes, id, now) {
  const node = find(nodes, id);
  if (!node) throw new TreeError('Не найдено', 404);
  if (node.deleted_at) throw new TreeError('Уже в корзине', 409);
  const changed = [node, ...descendants(nodes, id)].filter((n) => !n.deleted_at);
  for (const n of changed) {
    n.deleted_at = now;
    n.updated_at = now;
  }
  return changed;
}

export function restore(nodes, id, now) {
  const node = find(nodes, id);
  if (!node) throw new TreeError('Не найдено', 404);
  if (!node.deleted_at) throw new TreeError('Элемент не в корзине', 409);
  const ts = node.deleted_at;
  const group = [node, ...descendants(nodes, id).filter((d) => d.deleted_at === ts)];
  const parent = node.parent_id ? find(nodes, node.parent_id) : null;
  if (!parent || parent.deleted_at) node.parent_id = null; // родитель удалён -> в корень
  node.name = uniqueName(node.name, node.type, takenNames(nodes, node.parent_id));
  for (const n of group) {
    n.deleted_at = null;
    n.updated_at = now;
  }
  return group;
}

// Верхний уровень корзины: удалённые узлы, чей родитель не был удалён вместе с ними
export function trashRoots(nodes) {
  const by = new Map(nodes.map((n) => [n.id, n]));
  return nodes.filter((n) => {
    if (!n.deleted_at) return false;
    const p = n.parent_id ? by.get(n.parent_id) : null;
    return !p || p.deleted_at !== n.deleted_at;
  });
}

// Удаляет из индекса всё, что в корзине. Файлы в Telegram не затрагиваются.
export function purgeTrash(nodes) {
  const set = new Set(nodes.filter((n) => n.deleted_at).map((n) => n.id));
  for (let i = nodes.length - 1; i >= 0; i--) if (set.has(nodes[i].id)) nodes.splice(i, 1);
  return [...set];
}

export function pathOf(nodes, id) {
  const by = new Map(nodes.map((n) => [n.id, n]));
  const parts = [];
  const seen = new Set();
  let cur = by.get(id);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    parts.unshift(cur.name);
    cur = cur.parent_id ? by.get(cur.parent_id) : null;
  }
  return parts;
}

export function formatBytes(b) {
  if (b === null || b === undefined) return '';
  if (b < 1024) return `${b} Б`;
  const units = ['КБ', 'МБ', 'ГБ', 'ТБ'];
  let v = b;
  let i = -1;
  do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

// Ссылка на сообщение в приватном канале (работает для участников канала)
export function messageLink(n) {
  const c = String(n.tg_chat_id ?? '');
  if (!c.startsWith('-100') || !n.tg_message_id) return null;
  return `https://t.me/c/${c.slice(4)}/${n.tg_message_id}`;
}

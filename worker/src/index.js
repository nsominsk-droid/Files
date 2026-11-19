import * as T from '../../docs/tree.js';
import { extractFile, buildInlineResult, validateInitData, SEND_METHODS } from './telegram.js';

const COLS = 'id,parent_id,type,name,kind,mime,size,tg_chat_id,tg_message_id,file_id,created_at,updated_at,deleted_at';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Max-Age': '86400',
    };
    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...cors } });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    try {
      if (url.pathname === '/webhook' && request.method === 'POST') {
        if (!env.WEBHOOK_SECRET || request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) {
          return new Response('forbidden', { status: 403 });
        }
        const update = await request.json();
        try {
          await handleUpdate(update, env);
        } catch (e) {
          console.error('webhook error', e); // всегда отвечаем 200, чтобы Telegram не повторял апдейт бесконечно
        }
        return new Response('ok');
      }

      if (url.pathname.startsWith('/api/')) {
        const user = await authenticate(request, env);
        if (!user) return json({ error: 'Нет доступа. Откройте приложение заново из Telegram.' }, 401);
        return await handleApi(request, url, env, user, json);
      }

      return new Response('Saved Cloud API: ok', { headers: cors });
    } catch (e) {
      if (e instanceof T.TreeError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: 'Внутренняя ошибка сервера' }, 500);
    }
  },
};

// ---------- авторизация ----------

function allowedIds(env) {
  return String(env.ALLOWED_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
}

const isAllowed = (env, userId) => allowedIds(env).includes(String(userId)); // пустой список = доступ закрыт всем

async function authenticate(request, env) {
  const h = request.headers.get('Authorization') || '';
  if (!h.startsWith('tma ')) return null;
  const user = await validateInitData(h.slice(4), env.BOT_TOKEN);
  return user && isAllowed(env, user.id) ? user : null;
}

// ---------- работа с БД ----------

async function loadNodes(env) {
  const { results } = await env.DB.prepare(`SELECT ${COLS} FROM nodes`).all();
  return results;
}

async function saveChanged(env, changed) {
  if (!changed.length) return;
  const stmt = env.DB.prepare('UPDATE nodes SET parent_id = ?, name = ?, updated_at = ?, deleted_at = ? WHERE id = ?');
  await env.DB.batch(changed.map((n) => stmt.bind(n.parent_id ?? null, n.name, n.updated_at, n.deleted_at ?? null, n.id)));
}

async function insertNode(env, n) {
  const res = await env.DB.prepare(`INSERT OR IGNORE INTO nodes (${COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(n.id, n.parent_id ?? null, n.type, n.name, n.kind ?? null, n.mime ?? null, n.size ?? null,
      n.tg_chat_id ?? null, n.tg_message_id ?? null, n.file_id ?? null, n.created_at, n.updated_at, n.deleted_at ?? null)
    .run();
  return res;
}

// ---------- Telegram Bot API ----------

async function tg(env, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description || res.status}`);
  return data.result;
}

// ---------- API для Mini App ----------

async function handleApi(request, url, env, user, json) {
  const { pathname } = url;
  const method = request.method;
  const body = ['POST', 'PATCH'].includes(method) ? await request.json().catch(() => ({})) : {};
  const now = Date.now();
  let m;

  if (method === 'GET' && pathname === '/api/nodes') {
    return json({ nodes: await loadNodes(env) });
  }

  if (method === 'POST' && pathname === '/api/folders') {
    const nodes = await loadNodes(env);
    const node = T.createFolder(nodes, { parent_id: body.parent_id, name: body.name }, now, crypto.randomUUID());
    await insertNode(env, node);
    return json({ node });
  }

  if (method === 'POST' && pathname === '/api/trash/empty') {
    await env.DB.prepare('DELETE FROM nodes WHERE deleted_at IS NOT NULL').run();
    return json({ ok: true });
  }

  if ((m = pathname.match(/^\/api\/nodes\/([\w-]+)$/))) {
    const nodes = await loadNodes(env);
    if (method === 'PATCH') {
      const patch = {};
      if ('name' in body) patch.name = body.name;
      if ('parent_id' in body) patch.parent_id = body.parent_id;
      const changed = T.updateNode(nodes, m[1], patch, now);
      await saveChanged(env, changed);
      return json({ node: changed[0] });
    }
    if (method === 'DELETE') {
      await saveChanged(env, T.softDelete(nodes, m[1], now));
      return json({ ok: true });
    }
  }

  if (method === 'POST' && (m = pathname.match(/^\/api\/nodes\/([\w-]+)\/restore$/))) {
    const nodes = await loadNodes(env);
    await saveChanged(env, T.restore(nodes, m[1], now));
    return json({ ok: true });
  }

  // Отправить файл самому пользователю в чат с ботом (по file_id, без скачивания)
  if (method === 'POST' && (m = pathname.match(/^\/api\/nodes\/([\w-]+)\/send$/))) {
    const node = (await loadNodes(env)).find((n) => n.id === m[1]);
    if (!node || node.type !== 'file' || node.deleted_at) throw new T.TreeError('Файл не найден', 404);
    const spec = SEND_METHODS[node.kind];
    if (!spec) throw new T.TreeError('Этот тип файла нельзя отправить', 400);
    try {
      await tg(env, spec[0], { chat_id: user.id, [spec[1]]: node.file_id });
    } catch (e) {
      console.error(e);
      throw new T.TreeError('Не удалось отправить. Нажмите Start в чате с ботом и повторите.', 502);
    }
    return json({ ok: true });
  }

  return json({ error: 'Не найдено' }, 404);
}

// ---------- вебхук Telegram ----------

async function handleUpdate(update, env) {
  if (update.channel_post) return onChannelPost(update.channel_post, env);
  if (update.inline_query) return onInlineQuery(update.inline_query, env);
  if (update.message) return onMessage(update.message, env);
}

async function onChannelPost(msg, env) {
  if (String(msg.chat.id) !== String(env.CHANNEL_ID)) return; // чужие каналы игнорируем
  const f = extractFile(msg);
  if (!f) return;

  const nodes = await loadNodes(env);
  if (nodes.some((n) => n.tg_chat_id === String(msg.chat.id) && n.tg_message_id === msg.message_id)) return;

  // системная папка «Входящие»: создаём при первой необходимости или возвращаем из корзины
  const inbox = nodes.find((n) => n.id === 'inbox');
  if (!inbox) {
    const name = T.uniqueName('Входящие', 'folder', T.takenNames(nodes, null));
    const node = { id: 'inbox', parent_id: null, type: 'folder', name, created_at: Date.now(), updated_at: Date.now(), deleted_at: null };
    await insertNode(env, node);
    nodes.push({ kind: null, mime: null, size: null, tg_chat_id: null, tg_message_id: null, file_id: null, ...node });
  } else if (inbox.deleted_at) {
    await saveChanged(env, T.restore(nodes, 'inbox', Date.now()));
  }

  const node = T.createFile(nodes, {
    parent_id: 'inbox', name: f.name, kind: f.kind, mime: f.mime, size: f.size, file_id: f.file_id,
    tg_chat_id: String(msg.chat.id), tg_message_id: msg.message_id, created_at: (msg.date || 0) * 1000 || undefined,
  }, Date.now(), crypto.randomUUID());
  await insertNode(env, node);
}

async function onInlineQuery(q, env) {
  let results = [];
  if (isAllowed(env, q.from.id)) {
    const m = String(q.query || '').trim().match(/^f:?([\w-]+)$/);
    if (m) {
      const row = await env.DB.prepare(`SELECT ${COLS} FROM nodes WHERE id = ? AND type = 'file' AND deleted_at IS NULL`).bind(m[1]).first();
      const r = row && buildInlineResult(row);
      if (r) results = [r];
    }
  }
  await tg(env, 'answerInlineQuery', { inline_query_id: q.id, results, cache_time: 0, is_personal: true });
}

async function onMessage(msg, env) {
  if (msg.chat.type !== 'private' || !isAllowed(env, msg.from?.id)) return;
  const text = 'Каталог файлов. Отправляйте файлы в ваш канал, они появятся во «Входящих», а раскладывать их по папкам можно в приложении.';
  const payload = { chat_id: msg.chat.id, text };
  if (String(env.WEBAPP_URL || '').startsWith('https://')) {
    payload.reply_markup = { inline_keyboard: [[{ text: 'Открыть каталог', web_app: { url: env.WEBAPP_URL } }]] };
  }
  await tg(env, 'sendMessage', payload);
}

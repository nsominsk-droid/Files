// Интеграционный тест воркера: реальный SQLite (node:sqlite) вместо D1 и подменённый fetch для Telegram.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index.js';

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const wrap = (sql, params = []) => ({
    bind: (...p) => wrap(sql, p),
    async all() { return { results: db.prepare(sql).all(...params) }; },
    async first() { return db.prepare(sql).get(...params) ?? null; },
    async run() { db.prepare(sql).run(...params); return { success: true }; },
    _run: () => db.prepare(sql).run(...params),
  });
  return {
    prepare: (sql) => wrap(sql),
    async batch(stmts) { db.exec('BEGIN'); try { stmts.forEach((s) => s._run()); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } },
  };
}

const TOKEN = '111:TEST';
const OWNER = 42;
const CHANNEL = '-1001234567890';

function initData(userId = OWNER) {
  const fields = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: userId }) };
  const check = Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  return new URLSearchParams({ ...fields, hash: createHmac('sha256', secret).update(check).digest('hex') }).toString();
}

function setup() {
  const env = { DB: makeDb(), BOT_TOKEN: TOKEN, WEBHOOK_SECRET: 'sec', ALLOWED_USER_IDS: String(OWNER), CHANNEL_ID: CHANNEL, ALLOWED_ORIGIN: '*' };
  const tgCalls = [];
  globalThis.fetch = async (url, init) => {
    tgCalls.push({ method: String(url).split('/').pop(), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true, result: {} }));
  };
  const api = async (method, path, body, user = OWNER) => {
    const res = await worker.fetch(new Request('https://w.test' + path, {
      method,
      headers: { Authorization: 'tma ' + initData(user), 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }), env);
    return { status: res.status, data: await res.json() };
  };
  const hook = (update, secret = 'sec') => worker.fetch(new Request('https://w.test/webhook', {
    method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': secret }, body: JSON.stringify(update),
  }), env);
  return { env, api, hook, tgCalls };
}

const post = (message_id, extra) => ({ update_id: message_id, channel_post: { message_id, date: 1795000000, chat: { id: Number(CHANNEL), type: 'channel' }, ...extra } });

test('вебхук: файл из канала попадает во «Входящие», повторная доставка не дублирует', async () => {
  const { api, hook } = setup();
  assert.equal((await hook(post(1, { document: { file_id: 'F1', file_name: 'scan.pdf', file_size: 100 } }))).status, 200);
  await hook(post(1, { document: { file_id: 'F1', file_name: 'scan.pdf', file_size: 100 } }));
  await hook(post(2, { document: { file_id: 'F2', file_name: 'scan.pdf' } }));
  await hook(post(3, { text: 'просто текст' }));
  const { data } = await api('GET', '/api/nodes');
  const files = data.nodes.filter((n) => n.type === 'file');
  assert.deepEqual(files.map((n) => n.name).sort(), ['scan (2).pdf', 'scan.pdf']);
  assert.ok(files.every((n) => n.parent_id === 'inbox'));
  assert.equal(data.nodes.find((n) => n.id === 'inbox').name, 'Входящие');
});

test('вебхук: неверный секрет -> 403, чужой канал игнорируется', async () => {
  const { api, hook } = setup();
  assert.equal((await hook(post(1, { document: { file_id: 'F', file_name: 'a.pdf' } }), 'bad')).status, 403);
  const other = post(2, { document: { file_id: 'F', file_name: 'a.pdf' } });
  other.channel_post.chat.id = -100999;
  await hook(other);
  assert.equal((await api('GET', '/api/nodes')).data.nodes.length, 0);
});

test('API: без авторизации и чужой пользователь -> 401', async () => {
  const { env, api } = setup();
  const res = await worker.fetch(new Request('https://w.test/api/nodes'), env);
  assert.equal(res.status, 401);
  assert.equal((await api('GET', '/api/nodes', null, 999)).status, 401);
  env.ALLOWED_USER_IDS = '';
  assert.equal((await api('GET', '/api/nodes')).status, 401, 'пустой список = доступ закрыт');
});

test('API: папки, перенос, защита от цикла, корзина, восстановление, очистка', async () => {
  const { api, hook } = setup();
  const a = (await api('POST', '/api/folders', { parent_id: null, name: 'A' })).data.node;
  const b = (await api('POST', '/api/folders', { parent_id: a.id, name: 'B' })).data.node;
  assert.equal((await api('POST', '/api/folders', { parent_id: null, name: 'a' })).status, 409);
  assert.equal((await api('PATCH', `/api/nodes/${a.id}`, { parent_id: b.id })).status, 400);

  await hook(post(10, { document: { file_id: 'F', file_name: 'x.pdf' } }));
  let nodes = (await api('GET', '/api/nodes')).data.nodes;
  const file = nodes.find((n) => n.type === 'file');
  assert.equal((await api('PATCH', `/api/nodes/${file.id}`, { parent_id: b.id, name: 'y.pdf' })).status, 200);

  assert.equal((await api('DELETE', `/api/nodes/${a.id}`)).status, 200);
  nodes = (await api('GET', '/api/nodes')).data.nodes;
  assert.equal(nodes.filter((n) => n.deleted_at).length, 3);

  assert.equal((await api('POST', `/api/nodes/${a.id}/restore`)).status, 200);
  nodes = (await api('GET', '/api/nodes')).data.nodes;
  assert.equal(nodes.filter((n) => n.deleted_at).length, 0);
  assert.equal(nodes.find((n) => n.id === file.id).parent_id, b.id);

  await api('DELETE', `/api/nodes/${file.id}`);
  assert.equal((await api('POST', '/api/trash/empty')).status, 200);
  nodes = (await api('GET', '/api/nodes')).data.nodes;
  assert.ok(!nodes.some((n) => n.id === file.id));
  assert.ok(nodes.some((n) => n.id === a.id));
});

test('send: отправка по file_id; inline-запрос отвечает документом и закрыт для чужих', async () => {
  const { api, hook, tgCalls } = setup();
  await hook(post(5, { document: { file_id: 'FILE_ID', file_name: 'a.pdf' } }));
  const file = (await api('GET', '/api/nodes')).data.nodes.find((n) => n.type === 'file');

  assert.equal((await api('POST', `/api/nodes/${file.id}/send`)).status, 200);
  const sent = tgCalls.find((c) => c.method === 'sendDocument');
  assert.deepEqual(sent.body, { chat_id: OWNER, document: 'FILE_ID' });

  await hook({ update_id: 1, inline_query: { id: 'iq1', from: { id: OWNER }, query: `f${file.id}` } });
  const ans = tgCalls.filter((c) => c.method === 'answerInlineQuery').pop();
  assert.equal(ans.body.results[0].document_file_id, 'FILE_ID');

  await hook({ update_id: 2, inline_query: { id: 'iq2', from: { id: 999 }, query: `f${file.id}` } });
  assert.deepEqual(tgCalls.filter((c) => c.method === 'answerInlineQuery').pop().body.results, []);
});

test('«Входящие» возвращаются из корзины при новом файле', async () => {
  const { api, hook } = setup();
  await hook(post(1, { document: { file_id: 'F1', file_name: 'a.pdf' } }));
  await api('DELETE', '/api/nodes/inbox');
  await hook(post(2, { document: { file_id: 'F2', file_name: 'b.pdf' } }));
  const nodes = (await api('GET', '/api/nodes')).data.nodes;
  assert.equal(nodes.find((n) => n.id === 'inbox').deleted_at, null);
  assert.equal(nodes.find((n) => n.name === 'b.pdf').deleted_at, null);
});

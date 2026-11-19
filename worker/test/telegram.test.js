import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { extractFile, buildInlineResult, validateInitData } from '../src/telegram.js';

test('extractFile: документ, фото, GIF, голосовое, текст', () => {
  const date = 1795000000;
  assert.deepEqual(
    extractFile({ date, document: { file_id: 'D', file_name: 'scan.pdf', mime_type: 'application/pdf', file_size: 10 } }),
    { kind: 'document', file_id: 'D', name: 'scan.pdf', mime: 'application/pdf', size: 10 },
  );
  const photo = extractFile({ date, caption: 'Чек\nвторая строка', photo: [{ file_id: 'S', file_size: 1 }, { file_id: 'L', file_size: 9 }] });
  assert.equal(photo.file_id, 'L');
  assert.equal(photo.name, 'Чек.jpg');
  const gif = extractFile({ date, animation: { file_id: 'G' }, document: { file_id: 'G2', file_name: 'x.mp4' } });
  assert.equal(gif.kind, 'animation');
  assert.match(extractFile({ date, voice: { file_id: 'V' } }).name, /^Голосовое .*\.ogg$/);
  assert.equal(extractFile({ date, text: 'привет' }), null);
});

test('buildInlineResult: типы и неподдерживаемые', () => {
  assert.deepEqual(buildInlineResult({ id: 'i', kind: 'document', file_id: 'F', name: 'a.pdf' }), { type: 'document', id: 'i', document_file_id: 'F', title: 'a.pdf' });
  assert.equal(buildInlineResult({ id: 'i', kind: 'animation', file_id: 'F' }).type, 'mpeg4_gif');
  assert.equal(buildInlineResult({ id: 'i', kind: 'video_note', file_id: 'F' }), null);
});

function sign(fields, token) {
  const check = Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(check).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

test('validateInitData: валидная подпись, подделка, протухшие данные', async () => {
  const token = '123:ABC';
  const now = 1800000000;
  const fields = { auth_date: String(now - 60), query_id: 'q', user: JSON.stringify({ id: 42, first_name: 'Я' }) };
  const good = sign(fields, token);
  assert.equal((await validateInitData(good, token, { now }))?.id, 42);
  assert.equal(await validateInitData(good, 'другой:токен', { now }), null);
  assert.equal(await validateInitData(good.replace('42', '43'), token, { now }), null);
  assert.equal(await validateInitData(sign({ ...fields, auth_date: String(now - 90000) }, token), token, { now }), null);
  assert.equal(await validateInitData('', token, { now }), null);
});

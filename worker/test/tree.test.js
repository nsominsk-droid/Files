import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../../docs/tree.js';

let seq = 0;
const id = () => 'n' + ++seq;

function build() {
  const nodes = [];
  const work = T.createFolder(nodes, { parent_id: null, name: 'Работа' }, 1, 'work');
  const rep = T.createFolder(nodes, { parent_id: work.id, name: 'Отчёты' }, 1, 'rep');
  const y26 = T.createFolder(nodes, { parent_id: rep.id, name: '2026' }, 1, 'y26');
  T.createFile(nodes, { parent_id: y26.id, name: 'a.pdf', kind: 'document' }, 1, 'a');
  T.createFile(nodes, { parent_id: null, name: 'b.pdf', kind: 'document' }, 1, 'b');
  return nodes;
}

const get = (nodes, i) => nodes.find((n) => n.id === i);

test('sanitizeName: чистит символы и пустые имена', () => {
  assert.equal(T.sanitizeName('  a/b\\c  '), 'a-b-c');
  assert.equal(T.sanitizeName('x\u0000y'), 'xy');
  assert.throws(() => T.sanitizeName('   '));
  assert.throws(() => T.sanitizeName('..'));
  assert.equal(T.sanitizeName('я'.repeat(300)).length, 120);
});

test('uniqueName: добавляет (2) перед расширением, регистр не важен', () => {
  const taken = new Set(['отчёт.pdf', 'отчёт (2).pdf']);
  assert.equal(T.uniqueName('Отчёт.pdf', 'file', taken), 'Отчёт (3).pdf');
  assert.equal(T.uniqueName('Папка', 'folder', new Set(['папка'])), 'Папка (2)');
  assert.equal(T.uniqueName('v1.2 final', 'folder', new Set(['v1.2 final'])), 'v1.2 final (2)');
});

test('createFolder: дубликат имени -> 409, несуществующий родитель -> 404', () => {
  const nodes = build();
  assert.throws(() => T.createFolder(nodes, { parent_id: null, name: 'работа' }, 2, id()), (e) => e.status === 409);
  assert.throws(() => T.createFolder(nodes, { parent_id: 'nope', name: 'x' }, 2, id()), (e) => e.status === 404);
  assert.throws(() => T.createFolder(nodes, { parent_id: 'a', name: 'x' }, 2, id()), (e) => e.status === 404, 'родитель — файл');
});

test('updateNode: нельзя переместить папку в себя и в потомка', () => {
  const nodes = build();
  assert.throws(() => T.updateNode(nodes, 'work', { parent_id: 'work' }, 2), /самую себя|саму себя/);
  assert.throws(() => T.updateNode(nodes, 'work', { parent_id: 'y26' }, 2), /подпапку/);
  assert.doesNotThrow(() => T.updateNode(nodes, 'y26', { parent_id: null }, 2));
  assert.equal(get(nodes, 'y26').parent_id, null);
});

test('updateNode: перенос с конфликтом имён переименовывает автоматически, переименование — ошибка', () => {
  const nodes = build();
  T.createFile(nodes, { parent_id: 'y26', name: 'b.pdf' }, 1, 'b2');
  T.updateNode(nodes, 'b2', { parent_id: null }, 2);
  assert.equal(get(nodes, 'b2').name, 'b (2).pdf');
  assert.throws(() => T.updateNode(nodes, 'b2', { name: 'B.PDF' }, 3), (e) => e.status === 409);
  T.updateNode(nodes, 'b2', { name: 'c.pdf' }, 3);
  assert.equal(get(nodes, 'b2').name, 'c.pdf');
});

test('updateNode: смена только регистра собственного имени разрешена', () => {
  const nodes = build();
  T.updateNode(nodes, 'b', { name: 'B.pdf' }, 2);
  assert.equal(get(nodes, 'b').name, 'B.pdf');
});

test('updateNode: нельзя перенести в удалённую папку или в файл', () => {
  const nodes = build();
  T.softDelete(nodes, 'rep', 5);
  assert.throws(() => T.updateNode(nodes, 'b', { parent_id: 'rep' }, 6), (e) => e.status === 404);
  assert.throws(() => T.updateNode(nodes, 'b', { parent_id: 'a' }, 6), (e) => e.status === 404);
});

test('softDelete: удаляет поддерево с одной меткой, trashRoots показывает только корень группы', () => {
  const nodes = build();
  const changed = T.softDelete(nodes, 'rep', 10);
  assert.deepEqual(changed.map((n) => n.id).sort(), ['a', 'rep', 'y26']);
  assert.ok(nodes.filter((n) => n.deleted_at).every((n) => n.deleted_at === 10));
  assert.deepEqual(T.trashRoots(nodes).map((n) => n.id), ['rep']);
  assert.throws(() => T.softDelete(nodes, 'rep', 11), (e) => e.status === 409);
});

test('restore: восстанавливает группу целиком; ранее удалённое остаётся в корзине', () => {
  const nodes = build();
  T.softDelete(nodes, 'a', 5); // файл удалён раньше
  T.softDelete(nodes, 'rep', 10);
  T.restore(nodes, 'rep', 20);
  assert.equal(get(nodes, 'rep').deleted_at, null);
  assert.equal(get(nodes, 'y26').deleted_at, null);
  assert.equal(get(nodes, 'a').deleted_at, 5, 'файл, удалённый отдельно, не воскресает');
  assert.deepEqual(T.trashRoots(nodes).map((n) => n.id), ['a']);
});

test('restore: если родитель удалён — в корень, конфликт имён разрешается', () => {
  const nodes = build();
  T.softDelete(nodes, 'a', 5);
  T.softDelete(nodes, 'work', 10);
  T.createFile(nodes, { parent_id: null, name: 'a.pdf' }, 11, 'a_new');
  T.restore(nodes, 'a', 12);
  assert.equal(get(nodes, 'a').parent_id, null);
  assert.equal(get(nodes, 'a').name, 'a (2).pdf');
});

test('purgeTrash: удаляет только то, что в корзине', () => {
  const nodes = build();
  T.softDelete(nodes, 'rep', 10);
  const removed = T.purgeTrash(nodes);
  assert.equal(removed.length, 3);
  assert.deepEqual(nodes.map((n) => n.id).sort(), ['b', 'work']);
});

test('descendants не зацикливается на повреждённых данных', () => {
  const nodes = [
    { id: 'x', parent_id: 'y', type: 'folder', name: 'x' },
    { id: 'y', parent_id: 'x', type: 'folder', name: 'y' },
  ];
  assert.equal(T.descendants(nodes, 'x').length, 1);
});

test('formatBytes и messageLink', () => {
  assert.equal(T.formatBytes(500), '500 Б');
  assert.equal(T.formatBytes(2200000), '2.1 МБ');
  assert.equal(T.formatBytes(null), '');
  assert.equal(T.messageLink({ tg_chat_id: '-1001234567890', tg_message_id: 7 }), 'https://t.me/c/1234567890/7');
  assert.equal(T.messageLink({ tg_chat_id: '12', tg_message_id: 7 }), null);
});

test('pathOf', () => {
  assert.deepEqual(T.pathOf(build(), 'a'), ['Работа', 'Отчёты', '2026', 'a.pdf']);
});

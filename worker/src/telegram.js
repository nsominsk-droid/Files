import { splitExt } from '../../docs/tree.js';

// kind -> [метод Bot API, имя поля с file_id]
export const SEND_METHODS = {
  document: ['sendDocument', 'document'],
  photo: ['sendPhoto', 'photo'],
  video: ['sendVideo', 'video'],
  audio: ['sendAudio', 'audio'],
  voice: ['sendVoice', 'voice'],
  animation: ['sendAnimation', 'animation'],
  video_note: ['sendVideoNote', 'video_note'],
};

const stamp = (unix) => new Date(unix * 1000).toISOString().slice(0, 16).replace('T', ' ').replace(':', '-');
const withExt = (name, ext) => (splitExt(name)[1] ? name : name + ext);

// Достаёт файл из сообщения канала. Возвращает null, если в сообщении нет медиа.
export function extractFile(msg) {
  const when = stamp(msg.date || Date.now() / 1000);
  const cap = (msg.caption || '').split('\n')[0].trim().slice(0, 60);

  if (msg.animation) { // у GIF в сообщении есть и animation, и document — animation проверяем первым
    const a = msg.animation;
    return { kind: 'animation', file_id: a.file_id, name: withExt(a.file_name || cap || `GIF ${when}`, '.mp4'), mime: a.mime_type ?? null, size: a.file_size ?? null };
  }
  if (msg.video_note) {
    const v = msg.video_note;
    return { kind: 'video_note', file_id: v.file_id, name: `Кружок ${when}.mp4`, mime: 'video/mp4', size: v.file_size ?? null };
  }
  if (msg.video) {
    const v = msg.video;
    return { kind: 'video', file_id: v.file_id, name: withExt(v.file_name || cap || `Видео ${when}`, '.mp4'), mime: v.mime_type ?? null, size: v.file_size ?? null };
  }
  if (msg.audio) {
    const a = msg.audio;
    const title = [a.performer, a.title].filter(Boolean).join(' - ');
    return { kind: 'audio', file_id: a.file_id, name: withExt(a.file_name || title || cap || `Аудио ${when}`, '.mp3'), mime: a.mime_type ?? null, size: a.file_size ?? null };
  }
  if (msg.voice) {
    const v = msg.voice;
    return { kind: 'voice', file_id: v.file_id, name: `Голосовое ${when}.ogg`, mime: v.mime_type ?? 'audio/ogg', size: v.file_size ?? null };
  }
  if (msg.photo?.length) {
    const p = msg.photo[msg.photo.length - 1]; // последний — самый большой
    return { kind: 'photo', file_id: p.file_id, name: withExt(cap || `Фото ${when}`, '.jpg'), mime: 'image/jpeg', size: p.file_size ?? null };
  }
  if (msg.document) {
    const d = msg.document;
    return { kind: 'document', file_id: d.file_id, name: d.file_name || cap || `Файл ${when}`, mime: d.mime_type ?? null, size: d.file_size ?? null };
  }
  return null;
}

// Результат inline-запроса: отправка файла по file_id в любой чат. video_note inline не поддерживает.
export function buildInlineResult(node) {
  const id = node.id;
  const f = node.file_id;
  switch (node.kind) {
    case 'photo': return { type: 'photo', id, photo_file_id: f };
    case 'video': return { type: 'video', id, video_file_id: f, title: node.name };
    case 'audio': return { type: 'audio', id, audio_file_id: f };
    case 'voice': return { type: 'voice', id, voice_file_id: f, title: node.name };
    case 'animation': return { type: 'mpeg4_gif', id, mpeg4_file_id: f };
    case 'document': return { type: 'document', id, document_file_id: f, title: node.name };
    default: return null;
  }
}

const enc = new TextEncoder();

async function hmac(keyBytes, data) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// Проверка подписи initData из Telegram Mini App. Возвращает объект user или null.
export async function validateInitData(initData, botToken, { maxAge = 86400, now = Date.now() / 1000 } = {}) {
  if (!initData || !botToken) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get('hash');
  if (!hash) return null;
  p.delete('hash');
  const check = [...p.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = await hmac(enc.encode('WebAppData'), botToken);
  const calc = hex(await hmac(secret, check));
  if (!safeEqual(calc, hash)) return null;
  const authDate = Number(p.get('auth_date'));
  if (!authDate || now - authDate > maxAge) return null;
  try {
    const user = JSON.parse(p.get('user'));
    return user && user.id ? user : null;
  } catch {
    return null;
  }
}

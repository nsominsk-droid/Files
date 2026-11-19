1.1 # Saved Cloud

Файловый менеджер для Telegram: дерево папок любой вложенности поверх файлов, которые лежат в вашем приватном канале.
Файлы не загружаются и не скачиваются через приложение: вы шлёте их в канал как обычно, бот добавляет их во «Входящие», а вы раскладываете по папкам.

```
docs/      Mini App для GitHub Pages (index.html, app.js, style.css, config.js, tree.js)
worker/    Cloudflare Worker + D1: вебхук бота и API дерева
```

## 1. Демо без бэкенда (2 минуты)

1. Залейте репозиторий на GitHub.
2. Settings → Pages → Deploy from a branch → `main` / `/docs`.
3. Откройте `https://ВАШ_ЛОГИН.github.io/ИМЯ_РЕПО/`. Данные демо хранятся только в браузере.

## 2. Боевой режим

### Бот и канал
1. @BotFather → `/newbot` → сохраните токен.
2. @BotFather → `/setinline` → выберите бота → любой плейсхолдер (нужно для кнопки «Поделиться»).
3. Создайте **приватный канал**, добавьте бота администратором.
4. Ваш Telegram ID: напишите @userinfobot.
5. ID канала: отправьте любой пост в канал и откройте `https://api.telegram.org/bot<ТОКЕН>/getUpdates`, возьмите `channel_post.chat.id` (вида `-100…`). Делайте это до установки вебхука.
6. Нажмите Start в чате с ботом (иначе он не сможет отправлять вам файлы).

### Cloudflare (бесплатного тарифа хватает)
```bash
cd worker
npx wrangler login
npx wrangler d1 create saved-cloud                  # database_id вставьте в wrangler.toml
npx wrangler d1 execute saved-cloud --remote --file=schema.sql
# в wrangler.toml заполните ALLOWED_USER_IDS, CHANNEL_ID, WEBAPP_URL
npx wrangler secret put BOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET              # любая длинная случайная строка
npx wrangler deploy
```
Либо настройте автодеплой: секреты репозитория `CLOUDFLARE_API_TOKEN` и `CLOUDFLARE_ACCOUNT_ID`, workflow `.github/workflows/deploy-worker.yml` сам прогонит тесты и задеплоит.

### Вебхук
```bash
curl "https://api.telegram.org/bot<ТОКЕН>/setWebhook" \
  -d "url=https://saved-cloud-api.<ваш-субдомен>.workers.dev/webhook" \
  -d "secret_token=<WEBHOOK_SECRET>" \
  -d 'allowed_updates=["channel_post","message","inline_query"]'
```

### Фронтенд
1. В `docs/config.js` укажите `API_URL` (адрес воркера), закоммитьте.
2. @BotFather → `/setmenubutton` → ссылка на GitHub Pages, или кнопка «Открыть каталог» появится после `/start`.
3. Опционально в `wrangler.toml` поставьте `ALLOWED_ORIGIN = "https://ВАШ_ЛОГИН.github.io"`.

## Как это устроено

- Дерево хранится в D1 (таблица `nodes`), Telegram служит хранилищем файлов. Переименование, перенос и удаление меняют только индекс.
- Открыть файл: ссылка на сообщение в канале, файл откроется во встроенном просмотрщике Telegram.
- Поделиться: `switchInlineQuery` + inline-режим бота отправляет файл по `file_id` в любой чат. «Отправить мне» шлёт файл вам в чат с ботом.
- Удаление мягкое (корзина). «Очистить корзину» убирает записи из каталога, файлы в канале остаются.
- Доступ только у `ALLOWED_USER_IDS`. Каждый запрос подписан Telegram (`initData`, проверка HMAC на сервере). Пустой список закрывает доступ всем.

## Тесты

```bash
npm test      # логика дерева, разбор сообщений, проверка initData, API воркера на реальном SQLite
```

## Ограничения

- Каталог не видит файлы, отправленные в канал до добавления бота. Их можно переслать в канал заново.
- Если удалить сообщение в канале вручную, запись в каталоге останется «битой»: открытие покажет пустую ссылку.
- Видеокружки нельзя расшарить через inline (ограничение Telegram), но можно отправить кнопкой «Отправить мне».
- Telegram не гарантирует вечное хранение редко запрашиваемых медиа. Важное лучше дублировать.
- Рассчитано на одного владельца: параллельные правки с нескольких устройств в одно мгновение не защищены блокировками.

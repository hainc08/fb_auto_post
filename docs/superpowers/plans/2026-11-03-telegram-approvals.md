# Telegram Approvals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each member can connect their own Telegram bot in Settings. Every morning the bot sends the schedule posts that wait for approval, one message per post. The member reads each post and approves it with a button.

**Architecture:**
- A new table `telegram_bots` (one row per user) holds the encrypted bot token, the linked chat, the morning time and the last day a digest went out.
- Outbound: a small `TelegramClient`, and a `telegram_tick` job (every minute, like `schedule_tick`) that sends each due member's digest once a day.
- Inbound: Telegram calls a webhook, `POST /telegram/webhook/:userId`, outside `/api`. It is checked with Telegram's secret-token header. It links the chat (`/start <code>`) and handles button presses.
- Approving goes through one shared service, `approveSchedulePost`, which the web route uses too.

**Tech Stack:** Express + zod + Prisma (MariaDB), Node 20 `fetch`/`FormData`, Vitest, React 19 client.

**Spec:** none written. The decisions come from the user's request and answers of 2026-11-03:
1. Each member creates their own bot with @BotFather and pastes the token in Settings.
2. Per post the buttons are ✅ Duyệt, 📄 Xem đủ and 🌐 Mở trên web. There is no editing in Telegram.
3. The morning list holds only schedule posts waiting for approval (`scheduleQueued: true`, `status: READY`).

## Global Constraints

- Branch `feature/telegram-approvals` from `main`. Stage files by name; never commit `.env*`; never commit on `deploy`.
- UI copy and API error messages are in Vietnamese; code and comments in English.
- Schema changes are additive only. Apply them to the shared local DB with `npx prisma db execute --schema prisma/schema.prisma --file <sql>`, never `db push`. Also add them to `prisma/hostinger-schema.sql`.
- Tests never reach the real Telegram API: stub `fetch` for URLs containing `api.telegram.org` and pass every other URL to the real `fetch` (the test server uses it). They never run a worker.
- The bot token is a secret: stored with `encrypt`, read with `revealSecret`, never returned by any route, never in a log line or an error message (the token is part of Telegram's URL path, so errors must be redacted).
- Telegram messages are **plain text** (no `parse_mode`): AI-written captions contain `<`, `_` and `*`.
- Telegram limits: text 4096 characters, photo caption 1024, `callback_data` 64 bytes, `answerCallbackQuery` text 200.
- Times are Vietnam time (`Asia/Ho_Chi_Minh`); the morning time is `"HH:mm"` and defaults to `"08:00"`.
- Public address of the app: `publicUrl()` = `PUBLIC_URL` env, else `CLIENT_URL`, without a trailing slash. Telegram only delivers webhooks to `https`.
- Callback data: `a:<postId>` approve, `f:<postId>` full text, `noop` nothing.
- The webhook secret header is `X-Telegram-Bot-Api-Secret-Token`.

## Review Focus

1. **Webhook without the right secret** (no header, wrong header, unknown user id) gets 401 and changes nothing. A stranger who finds the URL can do nothing. → Task 5 test 1.
2. **A chat other than the linked one** can neither link (`/start` with a wrong or old code, or from a group) nor approve (a button press from another chat). → Task 5 tests 2 and 3.
3. **A callback carrying another member's post id** is "not found" and approves nothing. → Task 5 test 5.
4. **A stale or double tap** (already approved, deleted, already published) answers politely and never approves twice or throws. → Task 5 test 4.
5. **The digest goes out once a day:** two ticks at once, a restart, an empty queue, a blocked bot and a Telegram outage never send it twice, never spam an empty list, and never loop on a permanent error. → Task 6 tests.

---

### Task 1: Message rules (pure)

**Files:**
- Create: `src/lib/telegram-format.ts`
- Test: `tests/telegram-format.test.ts`

**Interfaces:**
- Produces:
  - `type InlineKeyboard = { inline_keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>> }`
  - Constants: `TG_TEXT_MAX = 4096`, `TG_CAPTION_MAX = 1024`, `CARD_CAPTION_MAX = 700`, `MAX_DIGEST_POSTS = 10`, `DIGEST_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/`.
  - `interface CardPost { id: string; caption: string | null; scheduledAt: Date | null; pageNames: string[]; productNames: string[]; hasVideo: boolean }`
  - `postCard(post: CardPost): string`
  - `digestHeader(total: number, shown: number): string`
  - `splitText(text: string, max?: number): string[]`
  - `approveKeyboard(postId: string, webUrl: string | null): InlineKeyboard`
  - `doneKeyboard(label: string): InlineKeyboard`
  - `parseCallback(data: string): { action: 'approve' | 'full'; postId: string } | { action: 'noop' } | null`
  - `vnDay(now: Date): string`, which returns `"YYYY-MM-DD"` in Vietnam time.
  - `digestDue(now: Date, digestTime: string, lastDigestOn: string | null): boolean`

- [ ] **Step 1: Write the failing tests** in `tests/telegram-format.test.ts`:
  - `postCard`, with `scheduledAt` `2026-11-04T01:00:00Z` (08:00 in Vietnam), two Pages and one product:
    - the card equals `'📝 Nhà nông, Hợp Phú · đăng 08:00 04/11\n\nLúa vàng lá\n\n🛒 Bình xịt 16L'`;
    - a null `scheduledAt` reads `đăng chưa có giờ`;
    - `hasVideo` adds the line `🎬 Bài có video`;
    - a 2,000-character caption is cut to 700 characters plus `…`;
    - `'<b>a_b*c</b>'` appears verbatim (no escaping).
  - `digestHeader(3, 3)` equals `'☀️ Chào buổi sáng! Có 3 bài đang chờ bạn duyệt.'`; `digestHeader(14, 10)` contains `Đang hiện 10 bài đầu — còn 4 bài`.
  - `splitText`:
    - 5,000 characters of short lines give chunks ≤ 4096 that rejoin to the original text (ignoring the newline at each cut);
    - one 5,000-character line without a newline is cut hard at 4096;
    - an empty string gives `[]`.
  - `approveKeyboard(id, 'https://app.test')` has two rows: `✅ Duyệt` with `callback_data: 'a:'+id` and `📄 Xem đủ` with `'f:'+id`, then `🌐 Mở trên web` with `url: 'https://app.test/posts?selected='+id`. With `'http://localhost:5173'` or `null` it has only the first row. Every `callback_data` is ≤ 64 bytes.
  - `parseCallback`: `a:<uuid>` and `f:<uuid>` parse; `noop` gives `{ action: 'noop' }`; `a:not-a-uuid`, `x:<uuid>` and `''` give `null`.
  - `vnDay(new Date('2026-11-03T17:30:00Z'))` equals `'2026-11-04'`.
  - `digestDue`:
    - 08:00 in Vietnam (`2026-11-04T01:00:00Z`), time `'08:00'`, no last day → true;
    - 07:59 → false;
    - `lastDigestOn` already `'2026-11-04'` → false;
    - yesterday's date → true;
    - 21:00 with no last day → true (the app was asleep: it catches up the same day).
- [ ] **Step 2: Run** `npx vitest run tests/telegram-format.test.ts`. Expected: FAIL, because the module is not found.
- [ ] **Step 3: Implement** the module. Use `Intl.DateTimeFormat` with `timeZone: 'Asia/Ho_Chi_Minh'` for the dates; no new dependency.
- [ ] **Step 4: Run** the tests again. Expected: PASS.
- [ ] **Step 5: Commit** `feat(telegram): message and digest-time rules`.

### Task 2: Schema and Telegram client

**Files:**
- Modify: `prisma/schema.prisma`, `prisma/hostinger-schema.sql`, `src/lib/job-queue.ts` (add `'telegram_tick'` to `JobType`).
- Create: `src/lib/clients/telegram.ts`
- Test: `tests/telegram-client.test.ts`

**Interfaces:**
- Produces:
  - `model TelegramBot` (table `telegram_bots`):
    - `id` uuid;
    - `userId` `@unique`, relation to `User` with `onDelete: Cascade`, and `User.telegramBot TelegramBot?`;
    - `botToken @db.Text` (encrypted); `botUsername @db.VarChar(100)`; `webhookSecret @db.VarChar(64)`;
    - `chatId String? @db.VarChar(40)`; `linkCode String? @db.VarChar(40)`;
    - `enabled Boolean @default(true)`; `digestTime String @default("08:00") @db.VarChar(5)`;
    - `lastDigestOn String? @db.VarChar(10)`; `lastError String? @db.Text`;
    - `createdAt`, `updatedAt`.
  - `class TelegramApiError extends Error { constructor(message: string, readonly code?: number) }`. `code` is Telegram's `error_code`, and is `undefined` for network failures.
  - `class TelegramClient { constructor(token: string) }` with:
    - `getMe(): Promise<{ id: number; username: string }>`
    - `setWebhook(url: string, secret: string): Promise<void>`, sending `url`, `secret_token` and `allowed_updates: ['message','callback_query']`
    - `deleteWebhook(): Promise<void>`
    - `sendMessage(chatId: string, text: string, replyMarkup?: InlineKeyboard, replyToMessageId?: number): Promise<{ messageId: number }>`
    - `sendPhoto(chatId: string, image: { buffer: Buffer; mime: string }, caption: string, replyMarkup?: InlineKeyboard): Promise<{ messageId: number }>`, as multipart
    - `setKeyboard(chatId: string, messageId: number, replyMarkup: InlineKeyboard): Promise<void>`, via `editMessageReplyMarkup`
    - `answerCallback(callbackQueryId: string, text?: string): Promise<void>`

- [ ] **Step 1: Write the failing tests** in `tests/telegram-client.test.ts`. Stub `fetch` inside each test.
  - `sendMessage posts JSON to the bot's method with the chat, the text and no parse_mode, and returns the message id`.
  - `sendPhoto sends multipart with chat_id, caption, reply_markup as a JSON string and the photo file`.
  - `setWebhook sends the url, the secret_token and only message and callback_query updates`.
  - `a Telegram error becomes a TelegramApiError with its code`: `{ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }`.
  - `the token never appears in an error`:
    - `description` contains the token;
    - `fetch` rejects with `new Error('request to https://api.telegram.org/bot<TOKEN>/sendMessage failed')`;
    - for both, `error.message` and `String(error)` do not contain the token, and `code` is `undefined` for the network failure.
- [ ] **Step 2: Run** `npx vitest run tests/telegram-client.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the client. Replace the token in every message with `***`, whatever its source.
- [ ] **Step 4: Edit** `schema.prisma` and `hostinger-schema.sql`.
  - Run `npx prisma validate`.
  - Get the SQL with `npx prisma migrate diff --from-schema-datamodel <HEAD's schema> --to-schema-datamodel prisma/schema.prisma --script`, keeping only the new table and its foreign key.
  - Apply it to the local DB with `db execute` (Docker must be up), then `npx prisma generate`.
  - Run `npx tsc --noEmit`.
- [ ] **Step 5: Run** `npx vitest run tests/telegram-client.test.ts`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(telegram): telegram_bots table and Telegram client`.

### Task 3: Shared approval service

**Files:**
- Create: `src/services/post-approval.ts`
- Modify: `src/routes/posts.routes.ts` (`POST /:id/approve` calls the service)
- Test: `tests/post-approval.db.test.ts`. The existing `tests/schedule-approve.db.test.ts` must stay green unchanged.

**Interfaces:**
- Produces: `approveSchedulePost(userId: string, postId: string): Promise<{ id: string; status: PostStatus; approvedAt: Date | null; scheduledAt: Date | null }>`.
  - It holds exactly the checks and messages the route has now:
    - 404 `Post not found`;
    - 400 for a post that is not a written, queued `READY` post;
    - 409 for no slot left;
    - the Page checks (`assertOwnPages`);
    - 409 `Bài vừa thay đổi, hãy tải lại.`;
    - the `approved` post log.
  - The route answers `{ success: true, data: <that object> }`.

- [ ] **Step 1: Write the failing tests** in `tests/post-approval.db.test.ts`, calling the service directly:
  - `approves a written queued post: SCHEDULED, approvedAt set, one "approved" log`;
  - `another member's post is 404 and untouched`;
  - `a second approval of the same post is refused (400) and logs nothing more`;
  - `a post with no slot left is refused (409)`.
- [ ] **Step 2: Run** `RUN_DB_TESTS=1 npx vitest run tests/post-approval.db.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Move** the route's body into the service. The route only parses and answers.
- [ ] **Step 4: Run** `RUN_DB_TESTS=1 npx vitest run tests/post-approval.db.test.ts tests/schedule-approve.db.test.ts tests/isolation.db.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `refactor(schedules): approval as a service shared with the web route`.

### Task 4: Settings API — connect, status, test, disconnect

**Files:**
- Create: `src/routes/telegram.routes.ts` (mounted at `/api/telegram`), `src/lib/telegram-link.ts`.
- Modify: `src/app.ts` (`API_ROUTERS`), `tests/isolation.db.test.ts`, `.env.example` (comment `# PUBLIC_URL=https://<your-domain>`).
- Test: `tests/telegram-settings.db.test.ts`

**Interfaces:**
- Consumes: `TelegramClient` and `TelegramApiError` (Task 2); `DIGEST_TIME_PATTERN` (Task 1).
- Produces:
  - `src/lib/telegram-link.ts`:
    - `publicUrl(): string`, which reads the env at call time;
    - `linkUrl(botUsername: string, code: string): string`, giving `https://t.me/<bot>?start=<code>`;
    - `newSecret(): string`, giving 64 hex characters;
    - `newLinkCode(): string`, giving 16 hex characters.
  - `GET /api/telegram`, answering `{ configured: boolean; botUsername: string | null; linked: boolean; linkUrl: string | null; enabled: boolean; digestTime: string; lastError: string | null; canReceive: boolean }`.
    - `canReceive` is `publicUrl()` starting with `https://`.
    - `linkUrl` is set only while a link code is pending.
    - No token, no secret, no chat id.
  - `PUT /api/telegram`, body `{ botToken?: string; enabled?: boolean; digestTime?: string }`:
    - With `botToken` it connects:
      - `getMe`; a Telegram 401 gives 400 `Token bot không đúng. Hãy sao chép lại token từ @BotFather.`;
      - refuse a non-https `publicUrl()` with 400 `Địa chỉ web của app chưa dùng https nên Telegram không gửi được tin về. Đặt PUBLIC_URL (hoặc CLIENT_URL) là địa chỉ https của app.`;
      - `setWebhook(publicUrl() + '/telegram/webhook/' + userId, secret)`;
      - upsert the row with the encrypted token, the username, a new secret and a new link code, and `chatId: null`.
    - Without `botToken` it saves `enabled` and `digestTime` on the existing row; with no row it answers 409 `Hãy dán token bot trước.`.
    - It answers the same body as `GET`.
  - `POST /api/telegram/link-code`: a new code, answering the `GET` body. The linked chat stays until a new `/start` replaces it.
  - `POST /api/telegram/test`: sends `✅ Kết nối thành công. Bot sẽ gửi các bài chờ duyệt vào mỗi sáng.` to the linked chat; without one, 409 `Chưa liên kết Telegram: hãy mở link và bấm Start trong Telegram.`; a `TelegramApiError` becomes 502 with its message.
  - `DELETE /api/telegram`: `deleteWebhook` (best effort), then the row is deleted.

- [ ] **Step 1: Write the failing tests** in `tests/telegram-settings.db.test.ts`. Stub `fetch` as in Global Constraints. Set `process.env.PUBLIC_URL = 'https://app.example.test'` in `beforeAll`.
  - `connect: getMe, setWebhook with the user's URL and a 64-hex secret, an encrypted token, a link URL`
    - `PUT { botToken: '123456:ABC-fake-token-for-tests' }` → 200 and `{ configured: true, botUsername: 'nhanong_bot', linked: false, enabled: true, digestTime: '08:00', canReceive: true }`.
    - `linkUrl` starts with `https://t.me/nhanong_bot?start=`.
    - `setWebhook` got `url` `https://app.example.test/telegram/webhook/<userId>` and `secret_token` matching `/^[0-9a-f]{64}$/`.
    - The row's `botToken` is not the plain token, and `revealSecret` of it is.
    - `JSON.stringify` of the `GET` answer contains neither the token nor the secret.
  - `a wrong token is refused and nothing is stored`: Telegram answers 401 → 400, matching `/Token bot không đúng/`, and no row.
  - `a non-https public address is refused before Telegram is called`: `PUBLIC_URL='http://localhost:5173'` → 400 matching `/https/`, with `getMe` never called. Restore the env afterwards.
  - `saving the time and the switch; a bad time is refused; without a row it is 409`:
    - `digestTime: '25:00'` → 400;
    - `{ enabled: false, digestTime: '07:30' }` is saved and returned;
    - a member without a row gets 409.
  - `connecting a new token resets the chat, the secret and the code`.
  - `link-code gives a new code and keeps the linked chat`.
  - `test: sends to the linked chat; not linked is 409; a Telegram refusal is 502 without the token in the message`.
  - `disconnect: deleteWebhook is called, the row is gone, another member's row stays`.
  - In `isolation.db.test.ts`:
    - give user B a `TelegramBot` row in the fixture, with the username containing `B_MARK`;
    - add `ROUTE_CASES` for `GET /api/telegram` (list), `PUT /api/telegram` (own-scope, body `{ enabled: true }`), `POST /api/telegram/link-code`, `POST /api/telegram/test`, `POST /api/telegram/digest` (reserved for Task 6; add it there) and `DELETE /api/telegram` (all own-scope);
    - B's row must stay unchanged.
- [ ] **Step 2: Run** `RUN_DB_TESTS=1 npx vitest run tests/telegram-settings.db.test.ts`. Expected: FAIL (404 on the routes).
- [ ] **Step 3: Implement** the router and `telegram-link.ts`; mount it in `app.ts`.
- [ ] **Step 4: Run** `RUN_DB_TESTS=1 npx vitest run tests/telegram-settings.db.test.ts tests/isolation.db.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(telegram): settings API to connect a member's own bot`.

### Task 5: Webhook — linking and buttons

**Files:**
- Create: `src/routes/telegram-webhook.routes.ts`, `src/services/telegram-updates.ts`.
- Modify: `src/app.ts` (mount `POST /telegram/webhook/:userId` directly on the app, before the SPA fallback, outside `/api` so the CSRF guard and login do not apply).
- Test: `tests/telegram-webhook.db.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4; `approveSchedulePost` (Task 3); `postMessageOf(post)` from `scheduler.service.ts`.
- Produces:
  - `handleTelegramUpdate(bot: TelegramBot, update: unknown): Promise<void>`. It never throws.
  - The route:
    - It looks the row up by `:userId` and compares the `X-Telegram-Bot-Api-Secret-Token` header with `webhookSecret` using `safeEqual`.
    - A missing row, a missing header and a wrong header all answer `401 { ok: false }` with the same body.
    - Otherwise it runs the handler and answers `200 { ok: true }`, even when the handler fails (so Telegram does not retry).
  - Behaviour of the handler:
    - **`/start <code>`** in a private chat with `code === linkCode`:
      - it sets `chatId` to the chat id (as a string), clears `linkCode` and `lastError`, and replies `✅ Đã liên kết. Mỗi sáng lúc <digestTime> bot sẽ gửi các bài chờ duyệt. Gõ /danhsach để nhận danh sách ngay.`;
      - a wrong code, no code, or a non-private chat links nothing and replies `Mã liên kết không đúng hoặc đã hết hạn. Hãy lấy mã mới trong Cài đặt → Telegram.`
    - **A callback from a chat other than `chatId`** (or while no chat is linked) only gets `answerCallback('Bạn không có quyền thao tác.')`.
    - **`a:<id>`** (approve, from the linked chat):
      - the post is looked up with `{ id, userId: bot.userId }`; not found answers `Không tìm thấy bài (có thể đã bị xoá).`;
      - a post that is already `SCHEDULED` and queued answers `Bài đã được duyệt trước đó.`, and the keyboard becomes `doneKeyboard('✅ Đã duyệt')`;
      - otherwise `approveSchedulePost`: on success it answers `Đã duyệt ✅` and sets `doneKeyboard('✅ Đã duyệt — đăng ' + the slot as HH:mm dd/MM)`; on an error it answers the error message cut to 200 characters.
    - **`f:<id>`** sends `postMessageOf(post)` (the text as it will be published, product links included) as plain messages split by `splitText`, the first as a reply to the card. It then answers the callback silently.
    - **`noop`**: answers the callback only.
    - Anything unrecognized is ignored.

- [ ] **Step 1: Write the failing tests** in `tests/telegram-webhook.db.test.ts`. Each posts an update over real HTTP to `/telegram/webhook/<userId>` with the header. The Telegram stub records `sendMessage`, `answerCallbackQuery` and `editMessageReplyMarkup` calls.
  1. `no header, a wrong header or an unknown user id gets 401 and nothing happens`: no Telegram call, and the row is unchanged.
  2. `/start with the right code in a private chat links it; a wrong code or a group does not`: `chatId` is `'111'`, `linkCode` is null, and the reply contains `Đã liên kết`. The wrong code and the group case change nothing and reply `không đúng`.
  3. `a stranger's chat can neither link nor approve`: after linking chat 111, `/start <old code>` from chat 222 changes nothing. A callback `a:<post>` from 222 answers `không có quyền` and the post stays `READY`.
  4. `approving: SCHEDULED with approvedAt, an answer and a "✅ Đã duyệt" keyboard; a second tap answers "đã được duyệt trước đó" and logs nothing more; a deleted post answers "Không tìm thấy bài"; a PUBLISHED post answers the service's message`.
  5. `another member's post id is not found and untouched`.
  6. `"Xem đủ" sends the text as it will be published, product links included, split at 4096 characters, in reply to the card`.
  7. `noop only answers; a malformed update ({}) and a failing Telegram answer (400 on answerCallbackQuery) still get HTTP 200`.
- [ ] **Step 2: Run** `RUN_DB_TESTS=1 npx vitest run tests/telegram-webhook.db.test.ts`. Expected: FAIL (404).
- [ ] **Step 3: Implement** the service and the route. Log failures as `[Telegram]` warnings, never with the token.
- [ ] **Step 4: Run** `RUN_DB_TESTS=1 npx vitest run tests/telegram-webhook.db.test.ts tests/isolation.db.test.ts`. Expected: PASS (the webhook is not in `API_ROUTERS`, so the isolation walk is unchanged).
- [ ] **Step 5: Commit** `feat(telegram): webhook links the chat and approves posts from buttons`.

### Task 6: Morning digest

**Files:**
- Create: `src/services/telegram-digest.ts`
- Modify:
  - `src/routes/telegram.routes.ts`: `POST /api/telegram/digest`.
  - `src/services/telegram-updates.ts`: the `/danhsach` command.
  - `src/services/scheduler.service.ts`: register `telegram_tick`; `bookTelegramTick()` in `startWorkers`.
- Test: `tests/telegram-digest.db.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 2 and 5; `readImage` (`src/lib/image-store.ts`); `productsOf` (`src/lib/post-products.ts`).
- Produces:
  - `DIGEST_TICK_KEY = 'system:telegram_tick'`.
  - `sendDigest(userId: string, opts?: { delayMs?: number }): Promise<{ total: number; sent: number }>`.
    - It reads the linked bot, then the member's posts with `scheduleQueued: true` and `status: 'READY'`, ordered by `scheduledAt` ascending (no slot last) then `createdAt`.
    - It sends nothing at all when there are none.
    - Otherwise it sends `digestHeader(total, shown)`, then one card per post, at most `MAX_DIGEST_POSTS`, with `approveKeyboard(post.id, webUrl)`, where `webUrl` is `publicUrl()` when it is https and otherwise null.
    - A post with an image uses `sendPhoto` (caption ≤ 1024); any other post uses `sendMessage`.
    - Messages are `delayMs` apart (default 300 ms; tests pass 0).
  - `runTelegramDigests(now = new Date(), where: Prisma.TelegramBotWhereInput = {}): Promise<number>`, which returns how many bots got a digest.
    - Candidates: `enabled`, `chatId` not null, and `digestDue(now, digestTime, lastDigestOn)`.
    - The day is claimed first with `updateMany` on `lastDigestOn` (null or not today) → today, so two ticks never both send.
    - After a claim it calls `sendDigest`.
    - Failure policy:
      - a Telegram 403 (blocked bot) sets `chatId` to null and `lastError` to `Bot bị chặn hoặc chat đã bị xoá: hãy liên kết lại trong Cài đặt → Telegram.`;
      - when nothing was delivered and the error is retryable (code 429, ≥ 500, or `undefined` for a network failure), the claim is given back (`lastDigestOn` restored) so the next tick retries;
      - any other error keeps the claim and records `lastError`;
      - a success clears `lastError`.
  - `runTelegramTickJob(): Promise<JobResult>`, which re-books itself every minute and never throws; `bookTelegramTick(): Promise<void>`, which books nothing when `config.env === 'test'`, like `bookScheduleTick`.
  - `POST /api/telegram/digest`: calls `sendDigest`; with `total === 0` it sends `Không có bài nào đang chờ duyệt 🎉`; it answers `{ total, sent }`. Without a linked chat it answers 409, like `POST /test`.
  - `/danhsach` in the webhook from the linked chat does the same as `POST /digest`.

- [ ] **Step 1: Write the failing tests** in `tests/telegram-digest.db.test.ts`. Call the functions directly, never a worker. `fetch` is stubbed and the Telegram stub records requests.
  - `sends the header and one card per waiting post, in slot order, with the approve keyboard`
    - Only queued `READY` posts of this member count. Leave out: a `SCHEDULED` queued post, a `DRAFT`, an ordinary `READY` post (`scheduleQueued` false), a `PUBLISHED` post, and another member's queued `READY` post.
    - The calls are `sendMessage` (header), then one call per post in slot order.
    - A post with an image goes through `sendPhoto`.
    - Each keyboard has `a:<postId>`.
    - Cards name the Page and the product.
  - `12 waiting posts: 10 cards, and the header says 2 more`.
  - `captions with < _ * reach Telegram verbatim and no request carries parse_mode`.
  - `no waiting posts: nothing is sent, and the manual /danhsach and POST /api/telegram/digest say there is nothing to approve`.
  - `runTelegramDigests`:
    - not due before the time → 0;
    - due → one digest;
    - the same day again → 0;
    - the next day → again;
    - an empty queue sends nothing but still marks the day;
    - a disabled or unlinked bot is skipped;
    - `Promise.all` of two runs sends once.
  - `a blocked bot (403) is unlinked with an explanation; a 429 with nothing delivered is retried on the next run; a 400 is not retried and is recorded`.
  - `POST /api/telegram/digest returns { total, sent }; without a linked chat it is 409`.
  - In `tests/isolation.db.test.ts`, add the `POST /api/telegram/digest` case (own-scope).
- [ ] **Step 2: Run** `RUN_DB_TESTS=1 npx vitest run tests/telegram-digest.db.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the service, the route, the `/danhsach` command and the job registration.
- [ ] **Step 4: Run** `RUN_DB_TESTS=1 npx vitest run tests/telegram-digest.db.test.ts tests/telegram-webhook.db.test.ts tests/telegram-settings.db.test.ts tests/isolation.db.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(telegram): morning digest of posts waiting for approval`.

### Task 7: Settings screen

**Files:**
- Create: `client/src/components/TelegramSettings.tsx`
- Modify:
  - `client/src/api.ts`: `telegramApi`: `get`, `connect(botToken)`, `save({ enabled?, digestTime? })`, `newLinkCode`, `test`, `sendDigest`, `disconnect`, and the `TelegramStatus` type from Task 4.
  - `client/src/pages/SettingsPage.tsx`: a `telegram` group in `SettingsGroup`, in the hash check and in `NAV` (icon `Send`), rendering `<TelegramSettings />`.
  - `client/src/index.css`.

**Interfaces:**
- Consumes: the endpoints of Tasks 4 and 6.
- Produces: the section "Telegram" in Settings. Copy, verbatim:
  - Steps: `1. Mở Telegram, tìm @BotFather, gõ /newbot và làm theo hướng dẫn. 2. Sao chép token bot nhận được và dán vào đây. 3. Bấm "Mở Telegram để liên kết" rồi bấm Start.`
  - With `canReceive` false, a warning: `Địa chỉ web của app chưa dùng https nên Telegram chưa gửi được tin về. Đặt PUBLIC_URL (hoặc CLIENT_URL) là địa chỉ https của app.`
  - Before connecting: a password field `Token bot` and the button `Kết nối bot`.
  - After connecting and before linking: the bot name, the button `Mở Telegram để liên kết` (opens `linkUrl` in a new tab), and the status refreshed every 3 seconds for up to 2 minutes until `linked`.
  - Linked: a switch `Gửi danh sách bài chờ duyệt mỗi sáng`, a time field `Giờ gửi` (`type="time"`, saved on change), and the buttons `Gửi thử`, `Gửi danh sách ngay` and `Lấy mã liên kết mới`. A row with `lastError` shows it as a warning.
  - `Ngắt kết nối` asks for confirmation (press twice, like other destructive buttons) before it calls `disconnect`.

- [ ] **Step 1: Build** the types, the component and the Settings entry. Follow the section pattern of `SettingsPage` (`settings-card`, `form-input`, `switch`) and existing CSS tokens.
- [ ] **Step 2: Verify the build.** In `client/`, run `npx -y -p node@22 -- node node_modules/typescript/bin/tsc -b`, `npm run lint` and `npx -y -p node@22 -- node node_modules/vite/bin/vite.js build`. Expected: no errors, and no new lint warnings in the new file.
- [ ] **Step 3: Check the real app locally.**
  - Run `.superpowers/precheck.ts`, start the API and the client, and use a temporary `@autopost.test` user.
  - Seed a `TelegramBot` row directly (a fake token) so the linked state renders without any Telegram call.
  - Look at the section in three states: nothing connected, connected and waiting for the link, and linked.
  - Never click a button that calls Telegram with the fake token.
  - Delete the temporary user and the scripts afterwards, and stop the servers.
- [ ] **Step 4: Commit** `feat(client): Telegram section in Settings`.

### Task 8: Docs and full run

**Files:**
- Modify: `CLAUDE.md`, `ROADMAP.md`, `docs/DEPLOY_HOSTINGER.md`.

- [ ] **Step 1: Write the docs.**
  - `CLAUDE.md`, a "Telegram approvals" paragraph:
    - the table and the settings routes;
    - the webhook outside `/api`, its secret header, and the two things it does;
    - `approveSchedulePost`;
    - the `telegram_tick` job and its once-a-day claim and failure policy;
    - plain text only;
    - the rule that the token is never returned, logged or left in an error.
  - `ROADMAP.md`: a ✅ line dated the finish day.
  - `DEPLOY_HOSTINGER.md`: `PUBLIC_URL` or `CLIENT_URL` must be the https domain; the `/cron/tick` cron must run every minute so the digest goes out on time; members create their own bots.
- [ ] **Step 2: Run** `npx tsc --noEmit` and `RUN_DB_TESTS=1 npx vitest run`, with no dev server running. Expected: all pass except the known drift test "duplicate name 409". If a test fails only in the parallel run, run that file alone and say so.
- [ ] **Step 3: Commit** `docs: Telegram approvals`.

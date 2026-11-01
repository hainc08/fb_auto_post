# Affiliate Products Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A member keeps a library of Shopee / Lazada / TikTok Shop affiliate links. They attach up to 3 of them to a post. The AI mentions the products in the post. The app adds their links at the end of the post and in the first comment. The AI reply drafts may answer "where do I buy?" with one of those links.

**Architecture:**
- One pure module, `src/lib/affiliate.ts`, owns all text rules:
  - the link block;
  - the first-comment placeholder;
  - the prompt block;
  - the reply link check.
- Two tables: `affiliate_products` holds the member's library, and `post_products` attaches products to posts.
- The links are never written by the AI. They are added from stored data:
  - when the post's message is composed at publish time;
  - when the first comment is posted.
- A slot schedule may rotate the domain's products into the posts it writes.

**Tech Stack:** Express + zod + Prisma (MariaDB), Vitest, React 19 client with plain CSS.

**Spec:** none written. The decisions below come from the user's answers on 2026-11-01:
1. Links are pasted by the member. There is no marketplace API.
2. The link goes in both the post body and the first comment.
3. Products are picked by hand when creating a post; slot schedules rotate the domain's products.
4. AI reply drafts may send a product link when someone asks to buy.

## Global Constraints

- UI copy, API error messages and docs are in Vietnamese; code and comments in English.
- Schema changes are additive only. Apply them to the shared local DB with `npx prisma db execute --schema prisma/schema.prisma --file <sql>`, never `db push` (it would drop SP1 workspace tables). Also add them to `prisma/hostinger-schema.sql`.
- Every query filters by `req.user.id`. Product ids from another user, including ids in a request body, return 404. Every new route goes into `ROUTE_CASES` in `tests/isolation.db.test.ts`.
- Tests never reach real Gemini or Facebook: spy on `GeminiClient.prototype.generateJson` and `FacebookClient.prototype.*`.
- The AI never writes a URL into the post. Links come only from `affiliate_products.url`.
- Limits:
  - 3 products per post;
  - 200 products per user;
  - name 1–200 chars;
  - url ≤ 1000 chars, `http:` or `https:` only;
  - highlights ≤ 500 chars;
  - price ≤ 50 chars.
- Platforms: `SHOPEE`, `LAZADA`, `TIKTOK`. Labels are "Shopee", "Lazada" and "TikTok Shop".
- First-comment placeholder: `{san_pham}`.
- Stage files by name and never commit `.env*`, `CR/`, `bugs/`, `prompt_creator_video.md` or `STORY_VIDEO_PLAN.pdf`. Work on branch `feature/affiliate-products` from `main`.

## Review Focus

1. **Product changed after it was attached.** Editing a product's link or name, or archiving it, after attaching it to a waiting post means the post publishes with the product's current link. An archived product attached to a post is still published, because the member chose it. → Task 5 test "uses the product's current link, archived or not".
2. **A placeholder with no products.** A domain template that uses `{san_pham}` on a post with no products drops the placeholder's line. A template that is only `{san_pham}` posts no comment at all. → Task 1 tests.
3. **An AI reply with a link that is not the product's.** The AI may change a link's query string, shorten it, or invent one. Such a reply gets no draft, so it can never be auto-sent. → Task 7 test.
4. **Changing a published post's products.** This is refused with the same 400 as other edits of a published post. → Task 4 test.
5. **A rotating schedule whose domain has no active product.** The schedule's posts are still written, with no product, and nothing fails. → Task 6 test.

---

### Task 1: Affiliate text rules (pure)

**Files:**
- Create: `src/lib/affiliate.ts`
- Test: `tests/affiliate.test.ts`

**Interfaces:**
- Produces:
  - `type AffiliatePlatform = 'SHOPEE' | 'LAZADA' | 'TIKTOK'`
  - `PLATFORM_LABEL: Record<AffiliatePlatform, string>`
  - `interface LinkProduct { name: string; url: string; platform: AffiliatePlatform; price?: string | null; highlights?: string | null }`
  - `platformOf(url: string): AffiliatePlatform | null`, which guesses the platform from the host:
    - `shopee.vn`, `*.shopee.vn`, `shope.ee` → SHOPEE
    - `lazada.vn`, `*.lazada.vn` → LAZADA
    - `tiktok.com`, `*.tiktok.com` → TIKTOK
    - anything else, or an unparsable URL → null
  - `linkBlock(products: LinkProduct[]): string`, which is `''` for no products, otherwise `"🛒 Mua ở đây:\n" + one line per product "👉 {name} ({label}): {url}"`.
  - `withLinkBlock(message: string, products: LinkProduct[]): string`: the message, a blank line, then the block; the message unchanged when there are no products.
  - `renderFirstComment(template: string | null, products: LinkProduct[]): string`. Rules:
    - the template is trimmed;
    - `{san_pham}` is replaced by `linkBlock(products)`;
    - with no products, every line that held the placeholder is removed;
    - a template without the placeholder gets the block appended after a blank line;
    - an empty template with products is the block alone;
    - the result is trimmed, and `''` means "post nothing".
  - `productPromptBlock(products: LinkProduct[]): string`, which is `''` for no products.
  - `replyLinksAllowed(reply: string, allowedUrls: string[]): boolean`, true when every `https?://\S+` in the reply, with trailing `.,;:!?)` stripped, is exactly one of `allowedUrls`.

- [ ] **Step 1: Write the failing tests** in `tests/affiliate.test.ts`:
  - `platformOf`:
    - `'https://s.shopee.vn/abc'` → `'SHOPEE'`
    - `'https://shope.ee/xyz'` → `'SHOPEE'`
    - `'https://c.lazada.vn/t/c.x'` → `'LAZADA'`
    - `'https://vt.tiktok.com/ZS1/'` → `'TIKTOK'`
    - `'https://example.com'` → `null`
    - `'not a url'` → `null`
  - `linkBlock([])` → `''`.
  - `linkBlock([{ name: 'Bình xịt 16L', url: 'https://s.shopee.vn/a', platform: 'SHOPEE' }, { name: 'Phân bón', url: 'https://c.lazada.vn/b', platform: 'LAZADA' }])` equals
    `'🛒 Mua ở đây:\n👉 Bình xịt 16L (Shopee): https://s.shopee.vn/a\n👉 Phân bón (Lazada): https://c.lazada.vn/b'`
  - `withLinkBlock('Bài viết', [])` → `'Bài viết'`; with one product → `'Bài viết\n\n🛒 Mua ở đây:\n👉 …'`.
  - `renderFirstComment`:
    - `('Link mua:\n{san_pham}\nCảm ơn cả nhà', [p])` → `'Link mua:\n🛒 Mua ở đây:\n👉 …\nCảm ơn cả nhà'`
    - `('Link mua:\n{san_pham}\nCảm ơn cả nhà', [])` → `'Link mua:\nCảm ơn cả nhà'`
    - `('{san_pham}', [])` → `''`
    - `('Ghé shop nhé', [p])` → `'Ghé shop nhé\n\n🛒 Mua ở đây:\n👉 …'`
    - `(null, [p])` → the block alone
    - `('Ghé shop nhé', [])` → `'Ghé shop nhé'`
  - `productPromptBlock([])` → `''`. With `{ name: 'Bình xịt 16L', price: '450.000đ', highlights: 'pin 12 tiếng' }` it contains:
    - `'Sản phẩm cần giới thiệu trong bài'`
    - `'- Bình xịt 16L — giá 450.000đ: pin 12 tiếng'`
    - `'không viết đường link'`
  - `replyLinksAllowed`:
    - `('Dạ link đây ạ: https://s.shopee.vn/a.', ['https://s.shopee.vn/a'])` → true
    - `('https://s.shopee.vn/a?x=1', ['https://s.shopee.vn/a'])` → false
    - `('https://evil.example', [])` → false
    - `('Dạ mời anh nhắn tin', [])` → true

- [ ] **Step 2: Run the tests and see them fail**
  Run: `npx vitest run tests/affiliate.test.ts`. Expected: FAIL, because the module is not found.

- [ ] **Step 3: Implement `src/lib/affiliate.ts`** with the signatures above.
  - `productPromptBlock` text, verbatim:
    ```
    Sản phẩm cần giới thiệu trong bài (nhắc tên và lợi ích một cách tự nhiên; không viết đường link; không bịa giá, khuyến mãi hay công dụng ngoài thông tin dưới đây — link mua hàng được thêm tự động cuối bài):
    - {name}[ — giá {price}][: {highlights}]
    ```

- [ ] **Step 4: Run the tests and see them pass**
  Run: `npx vitest run tests/affiliate.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(affiliate): link block, first-comment placeholder, prompt block, reply link check`.

### Task 2: Schema

**Files:**
- Modify: `prisma/schema.prisma`, `prisma/hostinger-schema.sql`

**Interfaces:**
- Produces, used by Tasks 3–8:
  - `enum AffiliatePlatform { SHOPEE LAZADA TIKTOK }`.
  - `model AffiliateProduct`, table `affiliate_products`:
    - `id` uuid; `userId`; `domainId String?`, where the relation `domain` uses `onDelete: SetNull`;
    - `platform AffiliatePlatform`; `name VarChar(200)`; `url Text`; `price VarChar(50)?`; `highlights VarChar(500)?`;
    - `isArchived Boolean @default(false)`; `lastUsedAt DateTime?`; `createdAt`; `updatedAt`;
    - the relation `user` uses `onDelete: Cascade`;
    - `@@index([userId, domainId])`.
  - `model PostProduct`, table `post_products`:
    - `postId`, `productId`, `sortOrder Int @default(0)`;
    - `@@id([postId, productId])`;
    - both relations use `onDelete: Cascade`;
    - `@@index([productId])`.
  - Back-relations: `Post.products PostProduct[]`, `AffiliateProduct.posts PostProduct[]`, `User.affiliateProducts`, `ContentDomain.affiliateProducts`.
  - `PostSchedule.affiliateRotate Boolean @default(false)`.

- [ ] **Step 1: Edit `schema.prisma`** as above, then run `npx prisma validate`. Expected: valid.
- [ ] **Step 2: Write the SQL and apply it locally.**
  - Get the `CREATE TABLE` / `ALTER TABLE` statements from `npx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script`.
  - Keep only the statements for the new objects. Drop any `DROP` line: those are SP1 drift.
  - Save the SQL to the scratchpad and apply it with `npx prisma db execute --schema prisma/schema.prisma --file <sql>`.
  - Add the same statements to `prisma/hostinger-schema.sql`, matching its existing style.
- [ ] **Step 3: Generate and typecheck.** Run `npx prisma generate && npx tsc --noEmit`. Expected: no errors.
- [ ] **Step 4: Commit** `feat(affiliate): products and post_products tables, schedule rotation flag`.

### Task 3: Product library API

**Files:**
- Create: `src/routes/products.routes.ts`
- Modify: `src/app.ts` (add `['/api/products', productsRoutes]` to `API_ROUTERS`), `tests/isolation.db.test.ts`
- Test: `tests/products-api.db.test.ts`

**Interfaces:**
- Consumes: the `AffiliateProduct` model from Task 2.
- Produces:
  - `GET /api/products?domainId=&archived=1`: the caller's products.
    - Sort order: not archived first, then `lastUsedAt` ascending with nulls first, then `createdAt`.
    - Each product carries `usedCount` (the number of posts it is attached to).
  - `POST /api/products`, body `{ platform, name, url, price?, highlights?, domainId? }`, answers 201 with the product.
  - `PATCH /api/products/:id`: the same fields, all optional, plus `isArchived`.
  - `DELETE /api/products/:id`:
    - 409 "Sản phẩm đã gắn vào bài — hãy lưu trữ thay vì xoá." when `usedCount > 0`;
    - otherwise it deletes the product.
  - An exported zod `productFields` object, which the client mirrors.
  - Error text, verbatim:
    - bad URL: "Link phải bắt đầu bằng http:// hoặc https://."
    - over the limit: "Tối đa 200 sản phẩm (tính cả sản phẩm đã lưu trữ)."
    - unknown product: "Không tìm thấy sản phẩm."
    - foreign or archived domain: 404 "Lĩnh vực không tồn tại."

- [ ] **Step 1: Write the failing tests** in `products-api.db.test.ts`. Use `createTestUser`, `api` from `tests/helpers/http.ts` and `cleanupTestUsers`.
  - `creates, lists, edits and archives a product; blank price and highlights clear them`
  - `refuses a link that is not http(s), a name over 200 characters and an unknown platform (400)`
  - `a domain of another user is 404; listing by domainId returns only that domain's products`
  - `deleting a product attached to a post is 409; an unused product is deleted`
  - `the 201st product is refused (409)`: seed 200 rows with `createMany`, then POST once.
  - `lists unused products first, then the least recently used`
- [ ] **Step 2: Run** `RUN_DB_TESTS=1 npx vitest run tests/products-api.db.test.ts`. Expected: FAIL (404 on the route).
- [ ] **Step 3: Implement the router.** Follow the `domains.routes.ts` patterns: `asyncHandler`, `createError`, and the `text()` helper for optional strings. Mount it in `app.ts`.
- [ ] **Step 4: Add the isolation cases.**
  - Add `productId` to the `Ids` type and to user B's fixture: one product created in the same setup that makes `domainId`.
  - Add four `ROUTE_CASES`:
    - `GET /api/products`: `list`.
    - `POST /api/products`: `own-scope`, with body `{ platform: 'SHOPEE', name: 'iso', url: 'https://s.shopee.vn/iso' }`.
    - `PATCH /api/products/:id`: `foreign-id`.
    - `DELETE /api/products/:id`: `foreign-id`.
  - Make B's product name contain B's marker, so the `list` case can detect it.
- [ ] **Step 5: Run** `RUN_DB_TESTS=1 npx vitest run tests/products-api.db.test.ts tests/isolation.db.test.ts`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(affiliate): product library API`.

### Task 4: Attach products to a post

**Files:**
- Create: `src/lib/post-products.ts`
- Modify: `src/routes/posts.routes.ts` (the `createPostSchema`/`updatePostSchema`, `POST /`, `PATCH /:id`, and the single-post GET)
- Test: `tests/post-products.db.test.ts`

**Interfaces:**
- Consumes: Task 2 models; Task 1 `linkBlock`.
- Produces:
  - `setPostProducts(tx: Prisma.TransactionClient, userId: string, postId: string, productIds: string[]): Promise<void>`.
    - It replaces the post's products, keeping the given order as `sortOrder`.
    - It throws 404 "Không tìm thấy sản phẩm." when an id is not the user's or is archived.
    - It throws 400 "Mỗi bài tối đa 3 sản phẩm." when there are more than 3.
    - It sets `lastUsedAt = now` on every attached product.
  - `productsOf(postId: string): Promise<Array<LinkProduct & { id: string }>>`, ordered by `sortOrder`, with each product's current data.
  - Post payloads (create, update, single GET) gain:
    - `products: Array<{ id, name, platform, url, price, highlights, isArchived }>`;
    - `affiliateBlock: string`, which is `linkBlock(products)` and is what the client previews.
  - `createPostSchema` and `updatePostSchema` gain `productIds: z.array(z.string().uuid()).max(3).optional()`. When it is absent, `PATCH` leaves the products as they are.

- [ ] **Step 1: Write the failing tests:**
  - `creates a post with two products in the chosen order and returns its link block`
  - `PATCH replaces the products; an empty list removes them; without productIds they stay`
  - `a product of another user or an archived product is 404 and nothing changes`
  - `four products are refused (400)`
  - `a published post's products cannot be changed (400)`, the existing published-post guard
- [ ] **Step 2: Run** `RUN_DB_TESTS=1 npx vitest run tests/post-products.db.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `post-products.ts` and wire it into the two handlers inside their existing transactions, or wrap each in one. Add `products` and `affiliateBlock` to the payloads.
- [ ] **Step 4: Run** the new file plus `tests/posts*.db.test.ts`. Expected: PASS. Existing payload assertions that use `toEqual` may need the two new keys.
- [ ] **Step 5: Commit** `feat(affiliate): attach up to 3 products to a post`.

### Task 5: The AI mentions the products; publishing adds the links

**Files:**
- Modify:
  - `src/lib/compose-prompt.ts`: `composePrompt` takes `products?: LinkProduct[]` and appends `productPromptBlock` as the last block before "Chỉ trả về JSON đúng schema."; the legacy path appends it after the idea.
  - `src/services/ai.service.ts`: `generateWithFormat` passes the products through.
  - `src/services/post-writer.ts`: `WritablePost` gains `id: string`, and `writePost` loads `productsOf(post.id)`.
  - `src/services/scheduler.service.ts`: `runPublishJob` builds `finalMessage` with `withLinkBlock(composeMessage(...), await productsOf(post.id))`. The first comment uses `renderFirstComment(domain?.firstCommentTemplate ?? null, products)`.
  - `src/routes/first-comment.routes.ts`: re-posting renders the comment the same way. The 400 "Lĩnh vực của bài chưa có mẫu bình luận đầu." now applies only when the rendered text is empty.
- Test:
  - `tests/compose-prompt.test.ts`: add cases.
  - `tests/first-comment.db.test.ts`: add cases.
  - `tests/affiliate-publish.db.test.ts`: new.

**Interfaces:**
- Consumes: Task 1 (`withLinkBlock`, `renderFirstComment`, `productPromptBlock`); Task 4 (`productsOf`).
- Produces: none new. The call sites change so that every caller of `postFirstComment` passes rendered text instead of the raw template. The signature stays `(targetId, facebook, pageToken, text)`.

- [ ] **Step 1: Write the failing tests.**
  - `compose-prompt.test.ts`:
    - `adds the product block before the JSON line`
    - `no products, no block`
    - `the legacy prompt gets the block after the idea`
  - `affiliate-publish.db.test.ts`:
    - It runs `runPublishJob` and `runTargetJob` directly, as `tests/first-comment.db.test.ts` does, with the Graph `fetch` stubbed and Gemini spied.
    - `the published message ends with the link block and the first comment carries it`
    - `uses the product's current link, archived or not`: attach, then PATCH the url and archive it, then publish. The new url is in the message.
    - `a post without products publishes exactly as before`
    - `writing the post sends the product block to Gemini`
  - `first-comment.db.test.ts`:
    - `a domain without a template still comments the links of a post with products`
    - `re-posting from the post page renders {san_pham}`
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement** the modifications listed above.
- [ ] **Step 4: Run** `npx vitest run tests/compose-prompt.test.ts` and `RUN_DB_TESTS=1 npx vitest run tests/affiliate-publish.db.test.ts tests/first-comment.db.test.ts tests/first-comment-route.db.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(affiliate): AI mentions the products, publishing adds their links to the post and first comment`.

### Task 6: Schedules rotate the domain's products

**Files:**
- Modify:
  - `src/services/schedule-runner.ts`: in `tickSchedule`'s post-creation transaction, when `schedule.affiliateRotate`, attach `pickNextProduct`.
  - `src/routes/schedules.routes.ts`: the `affiliateRotate` field on create and patch, and in the response.
- Create: `pickNextProduct` in `src/lib/post-products.ts`
- Test: `tests/schedule-affiliate.db.test.ts`

**Interfaces:**
- Produces: `pickNextProduct(tx: Prisma.TransactionClient, userId: string, domainId: string | null): Promise<string | null>`.
  - It returns the active product of that domain with the oldest `lastUsedAt` (nulls first, then `createdAt`).
  - It returns null when there is none.
  - The caller attaches the product with `setPostProducts`, which marks it used.

- [ ] **Step 1: Write the failing tests:**
  - `a rotating schedule gives its posts the domain's products in turn`: 2 products, 3 posts → A, B, A.
  - `a schedule without rotation writes posts without products`
  - `a rotating schedule whose domain has no active product still writes its posts`
  - `PATCH /api/schedules/:id { affiliateRotate: true } is saved and returned`
- [ ] **Step 2: Run** `RUN_DB_TESTS=1 npx vitest run tests/schedule-affiliate.db.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the changes above. Call `tickSchedule` directly in the tests; never start a worker.
- [ ] **Step 4: Run the tests again, with `tests/schedule*.db.test.ts`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(affiliate): slot schedules rotate the domain's products`.

### Task 7: Reply drafts may give the product link

**Files:**
- Modify:
  - `src/lib/reply-prompt.ts`:
    - `buildReplyPrompt` input gains `products?: Array<{ name: string; url: string }>`.
    - `cleanReplies` gains a third parameter, `allowedUrls: string[] = []`.
  - `src/services/reply-drafts.ts`: loads `productsOf(target.postId)` and passes the products and their urls.
- Test: `tests/reply-prompt.test.ts`, `tests/reply-drafts.db.test.ts`

**Interfaces:**
- Consumes: Task 1 `replyLinksAllowed`; Task 4 `productsOf`.
- Produces, as behaviour:
  - **Without products:** the prompt text is unchanged ("không hashtag, không đường link").
  - **With products:** the second line reads "không hashtag; chỉ được dùng đường link có trong danh sách sản phẩm bên dưới, và chỉ khi người bình luận hỏi mua, hỏi link hoặc nơi mua". The prompt also gets a block `Sản phẩm của bài (tên — link):` with one `- {name} — {url}` line per product.
  - `cleanReplies`: a reply for which `replyLinksAllowed` is false becomes `null` (no draft).

- [ ] **Step 1: Write the failing tests.**
  - `reply-prompt.test.ts`:
    - `lists the post's products and allows only their links`
    - `without products the prompt still forbids links`
    - `a reply with a link outside the list gets no draft; the exact product link is kept`
  - `reply-drafts.db.test.ts`:
    - `a post with a product sends the product to Gemini and keeps a reply that carries its link`
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run tests/reply-prompt.test.ts` and `RUN_DB_TESTS=1 npx vitest run tests/reply-drafts.db.test.ts tests/reply-autosend.db.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(affiliate): reply drafts may answer with the post's product link`.

### Task 8: Client

**Files:**
- Create:
  - `client/src/pages/ProductsPage.tsx` (route `/products`).
  - `client/src/components/ProductPicker.tsx`.
- Modify:
  - `client/src/api.ts`: `productsApi` (list/create/update/remove), the `AffiliateProduct` type, `products` and `affiliateBlock` on the post types, and `affiliateRotate` on the schedule types.
  - `client/src/App.tsx` (or wherever routes are declared): the `/products` route.
  - `client/src/components/Sidebar.tsx`: "Sản phẩm affiliate", under "Lĩnh vực".
  - `client/src/pages/CreatePostPage.tsx` and `client/src/components/EditPostModal.tsx`: the picker, and the preview shows `affiliateBlock`.
  - `client/src/pages/PostsPage.tsx`: the preview `composeMessage` appends `detail.affiliateBlock`.
  - `client/src/components/ScheduleForm.tsx`: a checkbox "Tự gắn sản phẩm affiliate của lĩnh vực (xoay vòng)".
  - `client/src/pages/DomainsPage.tsx`: the first-comment field's hint mentions `{san_pham}`.
  - `client/src/index.css`.

**Interfaces:**
- Consumes: the API shapes from Tasks 3, 4 and 6.
- Produces: `ProductPicker` props `{ domainId: string | null; value: string[]; onChange(ids: string[]): void }`.
  - It lists the domain's products first, then the others, without archived ones.
  - It allows at most 3, and shows the platform label and the price.
  - It has a "Thêm sản phẩm" link to `/products`.

- [ ] **Step 1: Build `ProductsPage`.**
  - A table with platform, name, price, domain and "Đã gắn N bài".
  - An add/edit form with platform (prefilled by guessing from the pasted link, mirroring `platformOf` client-side), name, link, price, highlights and domain.
  - Archive and restore buttons, and delete for unused products.
  - Follow `DomainsPage` patterns and existing CSS tokens.
- [ ] **Step 2: Add `ProductPicker`** to the create page and the edit modal. Send `productIds` and show `affiliateBlock` under the preview.
- [ ] **Step 3: Add the schedule checkbox and the `{san_pham}` hint.**
- [ ] **Step 4: Verify.** In `client/`, run `npx -y -p node@22 -- node node_modules/typescript/bin/tsc -b` and `npm run lint`. Expected: no new errors.
- [ ] **Step 5: Check the real app locally.**
  - First run `.superpowers/precheck.ts`, start the api and client, and use a temporary `@autopost.test` user.
  - Check: add a product, create a post with it, see the link block in the preview, and set rotation on a schedule.
  - Do not publish to Facebook.
  - Clean up the temporary user and stop the servers afterwards.
- [ ] **Step 6: Commit** `feat(client): affiliate product library, picker on posts, schedule rotation`.

### Task 9: Docs and full run

**Files:**
- Modify: `CLAUDE.md` (an "Affiliate products" paragraph in Architecture), `ROADMAP.md` (a ✅ line dated with the finish day).

- [ ] **Step 1: Write the docs.**
- [ ] **Step 2: Run everything.**
  - `npx tsc --noEmit`
  - `npx vitest run`
  - `RUN_DB_TESTS=1 npx vitest run`, with the dev server stopped first.
  - Expected: all pass except the known drift test "duplicate name 409" in `domains-api.db.test.ts`.
- [ ] **Step 3: Commit** `docs: affiliate products`.

# 🚀 Auto Post Facebook - Project Specification & Context

## 1. Tổng quan dự án (Project Overview)
**Auto Post Facebook** là một dịch vụ web SaaS giúp tự động hóa quy trình sáng tạo nội dung và đăng bài lên các Fanpage Facebook. Dự án chuyển đổi pipeline tự động hoá từ n8n thành một web app độc lập, tích hợp LLM (Google Gemini) để tạo caption và Cloudflare Workers AI để tạo hình ảnh.

**Ràng buộc & Ưu tiên cốt lõi:**
- Ứng dụng tập trung vào 2 module cốt lõi: **(A) Tạo bài đăng** và **(B) Cấu hình** hệ thống (Token, API keys, AI models). 
- **Tuyệt đối an toàn dữ liệu (Secret Security):** KHÔNG BAO GIỜ hard-code secret, không trả secret đầy đủ về client, mọi request ra bên ngoài (Gemini, Cloudflare, Facebook) PHẢI chạy ở Backend.
- Token và các Secret phải được mã hóa AES-256-GCM trong Database.
- Test tự động dùng mock, không gọi API thật.

## 2. Ngăn xếp Công nghệ (Tech Stack)
Cấu trúc hiện tại của dự án:
- **Frontend**: Vite + React, TypeScript, Vanilla CSS (Giao diện hiện đại, tối giản).
- **Backend**: Node.js, Express, TypeScript (có thể chuyển dịch sang Next.js App Router nếu cần thiết trong tương lai, nhưng hiện tại giữ nguyên kiến trúc chia tách).
- **Database**: MariaDB 11 (docker `autopost_mariadb`, port 3310) giao tiếp qua Prisma ORM (provider `mysql`). Các trường mảng/object như `hashtags` lưu dạng cột `Json`.
- **Job Queue**: BullMQ + Redis (Xử lý các tác vụ ngầm như sinh ảnh, gọi Facebook Graph API).
- **AI Integration**:
  - *Văn bản*: `@google/genai` (Google Gemini API).
  - *Hình ảnh*: API Cloudflare Workers AI (VD: `@cf/black-forest-labs/flux-1-schnell`).
  - *Facebook*: Dùng native `fetch` để gọi Graph API.

## 3. Cấu trúc Database (Prisma Schema)
- `Settings`: Lưu cấu hình toàn cục. Các trường secret (API Key, Token) được mã hóa `iv:authTag:ciphertext`.
- `User` & `FacebookPage`: Quản lý danh sách Fanpage.
- `Post`: Bài đăng (chứa chủ đề, thông tin cơ bản, caption AI, image prompt, đường dẫn ảnh, trạng thái, lỗi).
- `PostStep / PostLog`: Lưu lịch sử chạy từng bước của pipeline (thời gian, status, tóm tắt request/response không chứa token).
- `ContentTemplate`: (Tùy chọn/Mở rộng) Lưu các mẫu template prompt.

## 4. Các Module Tính Năng Cốt Lõi

### Module A — Tạo Bài Đăng (Create Post)
- **Input cơ bản**: Người dùng nhập `topic` (chủ đề), `tone` (giọng điệu), `language`, và `extraNotes` (ghi chú bổ sung).
- **Chế độ**: "Xem trước rồi đăng" (Mặc định) hoặc "Đăng ngay".
- **Pipeline Pipeline 7 Bước**:
  1. `generate_content`: Gọi Gemini (trả về JSON Structured Output gồm caption, hashtags, image_prompt).
  2. `compose_fields`: Ghép caption và hashtags thành `message` hoàn chỉnh.
  3. `generate_image`: HTTP POST gọi Cloudflare AI tạo ảnh bằng `image_prompt`.
  4. `save_image`: Lưu base64 thành file tại `./storage/images/{postId}.jpg`, phục vụ preview.
  5. `preview_stop`: Dừng lại chờ người dùng review nếu ở chế độ "Xem trước" (Status `READY`). Người dùng có thể sửa `message` hoặc `image_prompt` rồi "Tạo lại ảnh".
  6. `publish_facebook`: HTTP POST Graph API (dạng multipart/form-data) để đăng ảnh kèm message.
  7. `check_result`: Lưu `post_id` (trạng thái `PUBLISHED`) hoặc lưu thông tin mã lỗi (trạng thái `FAILED`).

### Module B — Cấu Hình (Settings)
- Quản lý các nhóm tham số (Lưu mã hóa, hiển thị che giấu `••••abcd` trên UI):
  - **Gemini**: API Key, Model, `systemPrompt`.
  - **Cloudflare**: Account ID, API Token, Image Model, Số Steps.
  - **Facebook**: App ID, App Secret, Page ID, Page Access Token, Graph Version.
- Các nút **Kiểm tra kết nối**: 
  - Gemini: Gửi prompt "ping".
  - Cloudflare: Gọi endpoint verify token.
  - Facebook: Gọi `/debug_token` để kiểm tra tính hợp lệ và scopes.
- Công cụ **Đổi token dài hạn**: Tiện ích đổi Short-lived token thành Long-lived token và chọn Page tự động.

## 5. Xử lý Lỗi & Retry
- **Timeouts**: Gemini (60s), Cloudflare (90s), Facebook (60s).
- **Retry Logic**: Tối đa 2 lần (backoff 1s, 3s) cho lỗi mạng hoặc HTTP 429/5xx. KHÔNG retry lỗi 4xx (Sai token, thiếu quyền).
- **Giao diện**: Các thông báo lỗi phải được dịch/trình bày dễ hiểu bằng tiếng Việt, mã lỗi gốc phải được lọc bỏ token trước khi hiển thị. Có nút "Chạy lại từ bước lỗi".

## 6. System Prompt Mặc Định
*(Cấu hình lưu trong bảng Settings, có thể chỉnh sửa qua UI)*
> Bạn là chuyên gia viết content mạng xã hội cho Fanpage [TÊN PAGE], đối tượng [ĐỐI TƯỢNG ĐỘC GIẢ]. Viết bài Facebook theo chủ đề, giọng điệu và ghi chú được cung cấp. Yêu cầu: câu mở đầu gây chú ý, đoạn ngắn dễ đọc trên điện thoại, kết thúc bằng lời kêu gọi tương tác. image_prompt phải bằng tiếng Anh, mô tả chủ thể, bối cảnh, ánh sáng, phong cách; không chứa chữ, logo hay người nổi tiếng. Chỉ trả về JSON đúng schema.

---
*Ghi chú:* File đặc tả này là tài liệu tham chiếu cao nhất cho mọi quyết định triển khai code. Mọi thay đổi về thư viện, mô hình dữ liệu (Database Schema) phải tuân thủ nghiêm ngặt các ràng buộc bảo mật và pipeline đã thống nhất ở trên.

# Plan — Facebook Story (ảnh + video 9:16 có giọng đọc & phụ đề karaoke)

> Review `prompt_creator_video.md` (2026-09-25). Trạng thái: **plan đã lưu, chưa làm** — chưa viết code, chưa thêm dependency, chưa gọi API thật.
>
> **Đã chốt (2026-09-25):** kịch bản = AI viết bản ngắn 40–100 từ, người dùng sửa được · render xong **xem trước rồi mới bấm Đăng** · GĐ0 (PoC FFmpeg trên Hostinger) làm khi bắt đầu phase này · TTS: ưu tiên **gói miễn phí** (xem mục 1b).

## 1. Kết luận khả thi

**Khả thi**, với 1 điều kiện phải kiểm chứng trước (GĐ0): Hostinger Business/Cloud có cho tiến trình Node chạy file thực thi FFmpeg (qua npm `ffmpeg-static`) và đủ CPU/RAM để render ~45 giây video 1080x1920 hay không.

| Hạng mục | Đánh giá | Ghi chú |
|---|---|---|
| Facebook Page Stories API | ✅ Khả thi, đúng quyền đang có | Luồng trong prompt khớp tài liệu Meta (start → upload → **poll trước** → finish). 3 quyền hiện có là đủ |
| TTS tiếng Việt có mốc từng từ | ✅ | ElevenLabs `with-timestamps` (fetch thuần) hoặc Azure `WordBoundary` (cần SDK) |
| Chuẩn hoá số/viết tắt tiếng Việt | ✅ Tự viết | Đọc số tiếng Việt có quy tắc riêng (mốt, lăm, linh, nghìn/triệu, dấu `.` ngăn nghìn) |
| Phụ đề karaoke `.ass` | ✅ | libass render dấu tiếng Việt tốt với font Be Vietnam Pro (OFL, được phép đóng gói) |
| FFmpeg trên Hostinger shared | ⚠️ **Chưa chắc** | Không cài được FFmpeg hệ thống; `ffmpeg-static` (bản build John Van Sickle, **có libass**) là file nhị phân trong `node_modules` — cần thử quyền thực thi + giới hạn CPU/RAM/thời gian |
| Chi phí | ✅ Thấp | Azure neural ~800 ký tự/video ⇒ vài trăm đồng/video; ElevenLabs cao hơn nhiều (tính theo gói) — *ước tính, kiểm tra bảng giá khi chọn* |

**Nếu GĐ0 thất bại** (không chạy được binary hoặc render quá chậm/bị kill): tách phần render ra 1 worker riêng trên VPS rẻ (vẫn đọc cùng hàng đợi MariaDB `jobs`) hoặc dịch vụ render API. Phần còn lại của plan không đổi.

## 1b. TTS miễn phí (có API, có mốc thời gian từng từ)

Phụ đề karaoke **bắt buộc** có mốc thời gian từng từ ⇒ loại các dịch vụ chỉ trả audio.

| Dịch vụ | Miễn phí | Tiếng Việt | Mốc từng từ | Ghi chú |
|---|---|---|---|---|
| **Azure AI Speech – gói F0** ✅ đề xuất | **500.000 ký tự/tháng**, không hết hạn (~600 video 60–100 từ/tháng) | vi-VN-HoaiMyNeural (nữ), vi-VN-NamMinhNeural (nam) | ✅ sự kiện `WordBoundary` | Cần SDK `microsoft-cognitiveservices-speech-sdk`; F0 giới hạn tốc độ gọi, đủ cho vài video/phút |
| Google Cloud TTS | 1 triệu ký tự/tháng (WaveNet/Neural2), 4 triệu (Standard) | Có giọng vi-VN | ⚠️ qua SSML `<mark>` (API v1beta1) — cần chèn mark từng từ, **thử trước** | Cần tài khoản billing (thẻ) dù dùng free |
| Gemini TTS (đã có key) | Theo hạn mức Gemini API | Có | ❌ không trả mốc từ | Phải thêm bước căn chỉnh (speech-to-text có timestamp) ⇒ phức tạp, dễ lệch |
| ElevenLabs Free | ~10 phút/tháng | Có | ✅ | Gói free **không dùng thương mại**, phải ghi nguồn ⇒ không hợp Page kinh doanh |
| Edge TTS (không chính thức) | Miễn phí | HoaiMy | ✅ | Endpoint trình duyệt Edge, **không có hợp đồng/ToS cho server** ⇒ có thể bị chặn bất cứ lúc nào — không dùng production |

⇒ Làm provider **Azure F0** trước, sau interface `synthesize()` chung; Google là phương án dự phòng.

## 2. Các điểm trong prompt cần sửa / bổ sung

| # | Prompt viết | Vấn đề | Đề xuất |
|---|---|---|---|
| 1 | Token/Page từ env `FB_PAGE_ID`, `FB_PAGE_TOKEN` | App đang quản lý **nhiều Page trong DB**, token mã hoá, có kiểm tra `postable` theo App ID | Dùng Page trong DB + `blockReason`; story đăng được lên nhiều Page như bài thường (giãn cách) |
| 2 | `TTS_API_KEY` từ env | Các key khác (Gemini, Cloudflare) nằm trong bảng `settings`, mã hoá, fallback `.env` | Thêm nhóm **Giọng đọc** trong Cài đặt (key mã hoá, nút Kiểm tra), fallback env `TTS_API_KEY`/`TTS_REGION` |
| 3 | Graph API **v25.0** cứng | App dùng `fbGraphVersion` trong Cài đặt (đang v23.0) | Dùng version trong Cài đặt; Stories API có từ các bản trước |
| 4 | Story ảnh: `POST /photos` với **`url`** | Ảnh của app phục vụ qua `/api/images/...` sau **Basic Auth** ⇒ Facebook không tải được | Upload **multipart `source`** (như đăng bài hiện tại), `published=false` |
| 5 | Video: 30fps H.264 + AAC | Meta yêu cầu audio **AAC-LC 48kHz, ≥128kbps**; thời lượng **3–60 giây** | `-ar 48000 -b:a 160k`; chặn cả < 3s và > 58s |
| 6 | Giới hạn ~150 từ | Tiếng Việt đọc ~2,5–3 từ/giây ⇒ 150 từ ≈ 50–60s, sát trần 58s. **Bài AI hiện tại thường 150–300 từ** ⇒ phần lớn bài sẽ bị từ chối | Thêm bước **AI viết "kịch bản story" ngắn (40–100 từ, hook + 1 ý + CTA)** từ bài, người dùng sửa được; giữ nguyên quy tắc "không tự cắt". Chặn cứng theo **thời lượng audio thật** |
| 7 | Căn mốc thời gian "theo cụm", fallback chia đều | Khó đúng nếu so khớp mờ | `prepareScript` sinh luôn **bảng ánh xạ** từng từ hiển thị → các từ đọc (vd "15%" → "mười lăm phần trăm" = 4 từ). Mốc của từ hiển thị = start từ đọc đầu → end từ đọc cuối. Chỉ fallback chia đều khi TTS trả số từ lệch |
| 8 | Dựng video: blur + overlay mỗi khung | Blur 1080x1920 × 30fps × 58s rất tốn CPU trên shared host | Render **nền tĩnh 1 lần** (ảnh blur + ảnh chính) thành PNG, rồi encode `-loop 1` + phụ đề, `-tune stillimage -preset veryfast` ⇒ nhanh hơn nhiều lần |
| 9 | `createStoryFromPost` chạy trọn 1→5 | Nên cho **xem trước video** trước khi đăng (chi phí TTS, chất lượng giọng) | 2 bước: *Tạo story* (render) → xem trước → *Đăng* lên các Page đã chọn |
| 10 | Retry 3 lần | Upload video bị timeout có thể đã lên Facebook | Giữ quy tắc như đăng bài: **không tự đăng lại** khi không rõ kết quả; báo người dùng kiểm tra |

## 3. Kiến trúc trong codebase hiện tại

```
Post (đã có nội dung + ảnh)
  └─ "Tạo Story" ─▶ post_stories (1 bản ghi / lần tạo): type PHOTO|VIDEO, storyScript, status, videoPath, durationMs
        │  job render_story (1 lần): prepareScript → synthesize (TTS) → build .ass → FFmpeg → storage/stories/{id}.mp4
        ▼  người dùng xem trước, chọn Page, bấm Đăng
     story_targets (story × Page): status, fbStoryId(post_id), error — như post_targets
        job publish_story (mỗi Page, giãn cách): upload media mới → photo_stories / video_stories
```

- Hàng đợi: bảng `jobs` MariaDB sẵn có (thêm type `render_story`, `publish_story`); `/cron/tick` đánh thức app như bài hẹn giờ.
- File tạm: `os.tmpdir()/autopost-story-{jobId}/` — xoá trong `finally` kể cả khi lỗi. Video kết quả lưu `STORAGE_DIR/stories/`.
- Chặn Page không hợp lệ (`blockReason`) ở cả route và worker như bài thường.

## 4. Giai đoạn (mỗi GĐ dừng lại cho bạn kiểm tra)

| GĐ | Nội dung | Kiểm tra |
|---|---|---|
| **0. PoC hạ tầng** (bắt buộc trước) | Thêm `ffmpeg-static`, route admin `/cron/ffmpeg-probe` (khoá CRON_SECRET) render 1 video mẫu 45s có phụ đề dấu tiếng Việt, đo thời gian/RAM | Chạy trên **Hostinger thật**: ra file đúng 1080x1920, thời gian render < 2 phút ⇒ đi tiếp; không ⇒ chọn phương án render ngoài |
| **1. Kịch bản** | `src/lib/story/prepare-script.ts`: `displayText`, `spokenText`, bảng ánh xạ từ; đọc số VN (0 → tỷ, thập phân, %, giờ `10:30`, ngày `25/9`, tiền `đ/k/tr`); `config/vi-abbreviations.json`; lỗi rõ khi > 150 từ. Gemini sinh `storyScript` ngắn | Unit test ~30 ca (21→"hai mươi mốt", 105→"một trăm linh năm", 1.500.000, 2,5%…) |
| **2. TTS** | `src/lib/story/tts/` interface `synthesize(text) → { audioPath, words }` + 1 provider (theo lựa chọn), nhóm Cài đặt "Giọng đọc" + nút Kiểm tra; cache audio theo hash nội dung (không trả tiền 2 lần khi render lại) | Test mock; **hỏi trước khi gọi TTS thật** |
| **3. Phụ đề + render** | `ass-builder.ts` (4–7 từ/dòng, ngắt ở dấu câu, `\k` cả khoảng lặng, escape `{ } \`, màu `&HAABBGGRR`); `render-video.ts` (execFile, nền tĩnh + `subtitles:fontsdir`, amix nhạc ~12%, 48kHz, `-t` = độ dài audio); font Be Vietnam Pro Bold trong `assets/fonts/` | Script `npm run story:sample` ra `story.mp4`; kiểm tra bằng ffprobe (1080x1920, thời lượng video = audio ±0,1s) |
| **4. Facebook Story client** | `FacebookClient.publishPhotoStory` (multipart unpublished → `photo_stories`), `publishVideoStory` (start → rupload với `Authorization: OAuth`, `offset`, `file_size` → poll `status` ≤ 60s → finish); log code/subcode/fbtrace_id, không lộ token | Test mock; **hỏi Page test** trước khi đăng thật |
| **5. Dữ liệu + job + API** | Schema `post_stories`, `story_targets` (**cần duyệt**); jobs `render_story`, `publish_story`; routes `POST /posts/:id/stories`, `GET /stories/:id/video`, `POST /stories/:id/publish`, `POST /stories/:id/targets/:tid/retry` | Test DB với Graph mock (như đăng nhiều Page) |
| **6. Giao diện** | Trong chi tiết bài: nút **Tạo Story** → chọn Ảnh/Video → sửa kịch bản → Render (tiến trình) → trình phát xem trước → chọn Page + giãn cách → Đăng → trạng thái từng Page + link | Chụp màn hình, test tay trên Page test |
| **7. Tài liệu** | README: biến môi trường, `ffmpeg-static`/libass, font, cách gọi; thêm `assets/`, `config/` vào `DEPLOY_PATHS` của branch deploy | — |

## 5. Dependency mới (cần duyệt)
- `ffmpeg-static` — FFmpeg + libass, không cần cài hệ thống.
- **Chỉ khi chọn Azure:** `microsoft-cognitiveservices-speech-sdk` (WordBoundary chỉ có qua SDK). ElevenLabs dùng `fetch` sẵn có — không thêm gì.
- File font **Be Vietnam Pro Bold** (SIL OFL) và nhạc nền (nếu dùng — cần bản quyền rõ ràng).

## 6. Rủi ro
- **Hostinger giới hạn CPU/tiến trình** → GĐ0 quyết định. Render chạy trong tiến trình con (`execFile`), không chặn web.
- **App ngủ giữa lúc render** → job bị đánh dấu `interrupted`, render lại (an toàn vì chưa đăng gì); publish thì theo quy tắc không đăng trùng hiện có.
- **Chất lượng giọng/phát âm** tên riêng, tiếng Anh xen kẽ → bảng viết tắt/phiên âm trong config, người dùng sửa kịch bản trước khi render.
- **Story tồn tại 24 giờ** → hợp cho nhắc lại bài chính/CTA; không thay bài đăng.

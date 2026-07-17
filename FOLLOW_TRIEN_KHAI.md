# Follow trien khai AI Video Studio

| Giai doan | Hang muc | Trang thai | Kiem tra that |
| --- | --- | --- | --- |
| 1 Pipeline CLI | Node.js/TypeScript | Done | `npm run typecheck`, `npm run build` |
| 1 Pipeline CLI | Nhan de tai mau | Done | `npm run generate -- "..."` hoac tao project web |
| 1 Pipeline CLI | AI tao `script.json` | Done co fallback | Gemini neu co key, fallback local neu loi de khong bi 0 scene |
| 1 Pipeline CLI | Edge TTS tao `voice.mp3` | Done | Render/audio job tao `voice.mp3` |
| 1 Pipeline CLI | Nhan MP4 | Done | Upload MP4 vao Media cua project |
| 1 Pipeline CLI | FFmpeg ghep MP4 + voice + nhac nen | Done mot phan | MP4 gan scene duoc dua vao `footagePlan`; audio asset dau tien lam background |
| 1 Pipeline CLI | Xuat `final.mp4` | Done | Output `video.mp4` trong folder render |
| 2 Backend API | API project/script/asset/voice/render | Done | Cac route `/api/projects`, `/generate-script`, `/assets`, `/voices`, `/render` |
| 2 Backend API | SQLite metadata | Done | `data/app.db` |
| 2 Backend API | Render job/progress | Done | `render_jobs`, polling `/api/render-jobs/:id` |
| 2 Backend API | Quan ly thu muc du an | Done local/server | `storage/projects`, `output`, optional `save_root` |
| 3 Web UI | Dashboard | Partial | Co du lieu DB, can bo analytics ao |
| 3 Web UI | Form tao du an | Done co fallback | Tao project xong sinh scenes |
| 3 Web UI | Upload video/MP3 | Done | Media upload va preview |
| 3 Web UI | Man hinh chinh scene | Done | Sua/them/xoa scene truc tiep |
| 3 Web UI | Nut render/progress | Done | Render selected project, progress poll |
| 3 Web UI | Trang ket qua | Partial | Xem/tai MP4/MP3, chon folder browser; can share TikTok/Facebook/Youtube |
| 4 APK | Capacitor | Not started | Can scaffold app Android |
| 4 APK | Quyen truy cap file Android | Not started | Can plugin permission |
| 4 APK | Upload tu bo nho Android | Not started | Can test tren thiet bi |
| 4 APK | Tai video dau ra | Not started | Can save/share intent |
| 4 APK | Ky APK noi bo | Not started | Can keystore/build |
| 5 Nang cao | AI chon canh theo transcript/hinh anh | Not started | Can scene analysis |
| 5 Nang cao | Auto crop chu the | Not started | Can computer vision/cropper |
| 5 Nang cao | Phu de hieu ung | Partial | Co SRT, chua burn subtitle effect |
| 5 Nang cao | Template video | Partial | Co HyperFrames templates |
| 5 Nang cao | Nhieu giong doc | Done UI/catalog | Runtime phu thuoc TTS provider |
| 5 Nang cao | Backend server/cloud | Not started | Can Postgres/object storage/deploy |
| Deploy private | Gmail allowlist | Done | `ALLOWED_EMAILS` chan user khong duoc share |
| Deploy private | Production start | Done | `npm run build && npm run start:prod` |
| Deploy private | Render/Node config | Done | `render.yaml`, `Procfile`, `Dockerfile` |
| Deploy private | Neon/R2 migration | Not started | Can `DATABASE_URL` va R2 keys |

## Luong chuc nang bat buoc

1. Tao project va de tai.
2. Sinh kich ban thanh scene that trong DB.
3. Sua scene truc tiep tren web.
4. Tao MP3 tu scene, luu lai thanh audio asset cua project.
5. Upload/gắn MP4 vao scene trong Timeline.
6. Render dung scene da sua va MP4 da gan.
7. Xem/tai video, hoac luu ve folder trinh duyet cho phep.

## Viec con lai de thanh web app dung tren moi may

- Dua DB tu SQLite local sang Postgres/cloud DB.
- Dua media/render output tu filesystem local sang object storage.
- Tao hang doi render server that.
- Them share/export len TikTok, Facebook, YouTube.
- Dong goi APK bang Capacitor.

# Deploy private/free cho AI Video Studio

Muc tieu: web app co URL rieng nhung khong public. Chi Gmail trong `ALLOWED_EMAILS` moi tao session va dung duoc API.

## 1. Khoa truy cap bang Gmail

Bat buoc set env:

```env
ALLOWED_EMAILS=you@gmail.com,nguoi-duoc-share@gmail.com
```

Neu Gmail khong nam trong danh sach nay, Google OAuth van login duoc voi Google nhung backend se tra `403` va khong tao session app.

Local test co the de trong, nhung khi deploy that thi phai set.

## 2. Database mien phi nen dung

Khuyen nghi: Neon Postgres.

Dung cho:
- users
- sessions
- user_settings
- projects
- scenes
- assets metadata
- render_jobs

Khong luu MP4/MP3 vao database.

Env du kien:

```env
DATABASE_URL=postgres://...
```

## 3. File storage mien phi nen dung

Khuyen nghi: Cloudflare R2.

Dung cho:
- MP4 upload
- MP3 voice
- image/logo
- video output
- script/subtitle output neu can

Env du kien:

```env
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=ai-video-studio
R2_PUBLIC_BASE_URL=
```

De private hon, khong can public bucket. Backend se doc/ghi file va cap signed URL/download qua API.

## 4. Google OAuth khi deploy

Local:

```env
GOOGLE_REDIRECT_URI=http://127.0.0.1:8787/api/auth/google/callback
```

Deploy:

```env
GOOGLE_REDIRECT_URI=https://ten-domain-cua-ban.com/api/auth/google/callback
```

Phai them redirect URI moi nay trong Google Cloud Console.

## 5. Thu tu lam dung

1. Tao Neon project free va lay `DATABASE_URL`.
2. Tao Cloudflare R2 bucket free va lay access key.
3. Sua code DB adapter tu SQLite sang Postgres.
4. Sua asset/output storage tu filesystem sang R2.
5. Deploy backend + public UI.
6. Set `ALLOWED_EMAILS`.
7. Doi Google OAuth callback sang domain deploy.
8. Test full flow: login -> tao project -> script -> MP3 -> upload MP4 -> render -> download.

## 6. Luu y mien phi

- Neon/R2 free du cho test va dung ca nhan nho.
- Render video ton CPU, nen hosting free co the timeout neu video dai.
- Cach ben vung hon: web/API tren server, render worker rieng co FFmpeg.
- Dung luong video se het nhanh hon database. Neu upload nhieu MP4, R2 10GB free la gioi han can theo doi dau tien.

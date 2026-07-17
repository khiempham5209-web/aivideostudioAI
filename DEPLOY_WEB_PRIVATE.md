# Deploy ban web private

Ban nay khong deploy moi `public/index.html` rieng. `index.html` duoc backend Node serve tai `/`, con API nam cung domain.

## Cach dong thanh web

Build:

```bash
npm ci
npm run build
npm run start:prod
```

Sau do mo domain cua server. Local la:

```text
http://127.0.0.1:8787
```

## Huong deploy free de test

Nen dung Render Free Web Service truoc vi app can Node server. Vercel/Netlify khong phu hop cho render FFmpeg dai va file tam local.

### Buoc 1 - dua code len GitHub private

Repo nen de private.

### Buoc 2 - tao Render Web Service

- New Web Service
- Connect repo private
- Runtime: Node
- Build command:

```bash
npm ci && npm run build
```

- Start command:

```bash
npm run start:prod
```

Render cung co the doc `render.yaml` trong repo.

### Buoc 3 - set env

Bat buoc:

```env
NODE_ENV=production
APP_ENV=production
NODE_NO_WARNINGS=1
ALLOWED_EMAILS=gmail-cua-ban@gmail.com
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=https://ten-app.onrender.com/api/auth/google/callback
APP_PUBLIC_URL=https://videostudioai-iota.vercel.app
GEMINI_API_KEY=...
```

Chua bat buoc nhung se can cho cloud storage/database:

```env
DATABASE_URL=...
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=ai-video-studio
```

### Buoc 4 - sua Google OAuth

Trong Google Cloud Console, them Authorized redirect URI:

```text
https://ten-app.onrender.com/api/auth/google/callback
```

Sau do cap nhat env `GOOGLE_REDIRECT_URI` dung y nhu tren.

### Buoc 4.1 - noi Vercel voi Render

Sau khi tao Render backend, sua `vercel.json`:

```json
{
  "source": "/api/:path*",
  "destination": "https://TEN-BACKEND.onrender.com/api/:path*"
}
```

Trong Render backend, set:

```env
APP_PUBLIC_URL=https://videostudioai-iota.vercel.app
```

Ket qua:

- User mo `https://videostudioai-iota.vercel.app/`
- Index goi `/api/...`
- Vercel rewrite `/api/...` sang Render backend
- Google login callback ve Render backend
- Render tao session roi redirect lai Vercel

### Buoc 5 - khi da co Neon/R2

Kiem tra bien moi truong:

```bash
npm run cloud:check
```

Tao schema Postgres:

```bash
npm run db:init
```

## Che do private

Neu `APP_ENV=production` ma khong co `ALLOWED_EMAILS`, backend se khong cho bat dau Google login.

Neu user login bang Gmail khong nam trong `ALLOWED_EMAILS`, backend tra `403` va khong tao session.

## Luu y free tier

- Render Free co the sleep khi khong dung.
- Render Free filesystem la tam thoi, khong nen coi la storage chinh.
- Video render bang FFmpeg ton CPU; video dai co the cham hoac timeout.
- Buoc tiep theo de dung ben vung: Neon Postgres cho DB, Cloudflare R2 cho MP4/MP3/output.

# Smart FTTH Planning Platform

Single HTML Application (vanilla JS + Leaflet + Supabase) untuk perencanaan jaringan FTTH:
Boundary → Analisa Area → Auto Network Planning → Review/Approval → BOQ/Proposal →
Construction/QC/As Built → Asset Management.

## 1. Struktur file

```
index.html                    <- buka file ini di browser / hosting statis
config.js                     <- WAJIB diisi (Supabase URL & anon key) sebelum dipakai
style.css
app.js
planning-engine.js
planning-analyzers.js
planning-generators.js
planning-final.js
supabase/schema_full.sql      <- jalankan di Supabase SQL Editor (1 file, mandiri, idempoten)
```

## 2. Setup cepat

1. **Buat project Supabase** (gratis) di https://supabase.com.
2. **Jalankan `supabase/schema_full.sql`** di Supabase Dashboard → SQL Editor. Aman dijalankan
   berkali-kali.
3. **Buat 2 Storage bucket** di Supabase Dashboard → Storage:
   - `asset-photos` (disarankan public read)
   - `asset-documents` (public read atau private, sesuai kebijakan Anda)
4. **Edit `config.js`**, isi:
   ```js
   SUPABASE_URL: 'https://xxxxxxxx.supabase.co',
   SUPABASE_ANON_KEY: 'ey...', // ANON key, JANGAN service_role key
   ```
5. **Deploy** — karena ini murni file statis (HTML/CSS/JS, tanpa build step), Anda bisa:
   - Push ke GitHub lalu aktifkan **GitHub Pages** (Settings → Pages → Deploy from branch), atau
   - Drag-drop folder ini ke **Netlify**/**Vercel**/**Cloudflare Pages**, atau
   - Upload ke hosting statis apa pun.

Tidak ada `npm install` / build step — buka `index.html` langsung sudah cukup untuk uji lokal
(gunakan extension "Live Server" di VS Code, atau `python3 -m http.server`, supaya `fetch()`
ke Supabase tidak diblokir CORS oleh `file://`).

## 3. Login pertama kali
User pertama yang mendaftar (Supabase Auth) otomatis mendapat role **admin** (lihat
Migration 001 di `schema_full.sql`). User berikutnya default **editor**. Ubah role lewat tabel
`profiles` (kolom `role`: `admin`/`editor`/`viewer`) bila perlu.

## 4. Dokumentasi lengkap
Lihat seluruh laporan `REVISION_0X_REPORT.md` dan `FINAL_*.md` yang menyertai proyek ini untuk
riwayat fitur, hasil audit, panduan deployment rinci, dan status pengujian.

## 5. Catatan penting
- `config.js` di paket ini **direkonstruksi dari analisis kode** (file asli sempat hilang dari
  proses upload) — silakan sesuaikan `NAV_GROUPS`/`ASSET_DEFS` bila Anda punya versi asli yang
  berbeda strukturnya. Lihat `FINAL_AUDIT_REPORT.md` §0 untuk detail.
- Keamanan sepenuhnya bergantung pada Row Level Security (RLS) Supabase (sudah aktif di semua
  tabel) + ANON key di `config.js` — JANGAN PERNAH menaruh `service_role` key di file ini karena
  akan terlihat publik oleh siapa pun yang membuka website.

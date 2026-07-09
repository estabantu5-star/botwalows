# 🚀 WhatsApp Multi-Pairing Bot Hub
### View Once Bypasser (RVO), BRAT Sticker Maker, and Multi-Downloader

WhatsApp Bot Hub adalah aplikasi WhatsApp Bot berbasis web-dashboard yang mendukung **Multi-Pairing** (menjalankan banyak bot sekaligus dari nomor berbeda), lengkap dengan fitur anti-tampilan sekali (Read View Once), pembuat stiker ala album BRAT, serta media downloader serbaguna.

---

## ✨ Fitur Utama

1. **👥 Multi-Pairing Session Manager**
   - Jalankan banyak nomor bot WhatsApp sekaligus dalam satu server.
   - Dashboard web interaktif untuk menambah, memonitor status (`CONNECTING`, `CONNECTED`, `DISCONNECTED`), melihat *live logs* spesifik per nomor, dan memutuskan sesi.
   - Auto-reconnect & auto-restore sesi ketika server di-restart (sesi disimpan aman dalam folder `auth_info_baileys_[nomor_hp]`).

2. **👁️ Read View Once Bypasser (RVO)**
   - Otomatis membongkar kiriman media (Foto/Video) sekali lihat (*View Once*) saat Anda membalas pesan tersebut dengan mengetik **`rvo`**.
   - Media sekali lihat akan langsung dikirim kembali ke ruang obrolan sebagai foto atau video biasa.

3. **🎨 BRAT Sticker Generator**
   - Ketik **`.brat <teks>`** untuk membuat stiker statis dengan latar belakang hitam ala album BRAT karya Charli XCX.
   - Ketik **`.bratvid <teks>`** untuk membuat stiker animasi berkedip/bergerak.
   - Kustomisasi warna teks & background menggunakan pemisah `|`. Contoh: `.brat teks keren | #ff0000 | #000000` (format: `.brat <teks> | <warna_teks> | <warna_bg>`).

4. **📥 Multi-Downloader (DL)**
   - Unduh video, audio, atau rangkaian foto (TikTok Slide/IG Multi-Image) dengan mengetik perintah `.tt <link>`, `.ig <link>`, `.yt <link>`, atau `.dl <link>`.
   - Menggunakan Nexa Downloader API untuk mengunduh media dari TikTok, Instagram, YouTube, dll. secara otomatis.

5. **🎵 Spotify Downloader (NEW)**
   - Unduh lagu langsung dari Spotify menjadi file audio MP3 berkualitas tinggi.
   - Cukup ketik **`.spotify <link_lagu_spotify>`**. Bot akan menampilkan cover art, judul, nama artis, dan mengirim audionya secara langsung.
   - Didukung oleh integrasi Azbry API.

6. **💻 cURL Executor (NEW)**
   - Eksekusi perintah cURL HTTP request langsung dari chat WhatsApp Anda menggunakan perintah **`.curil <perintah_curl>`**.
   - Sangat berguna untuk pengujian API, debugging, atau mengeksekusi request kompleks dengan kustomisasi Headers, Methods, dan Request Body secara instan.
   - Jika respon terlalu panjang (>3500 karakter), bot akan secara otomatis mengirimkannya dalam format file dokumen `.json` yang rapi agar WhatsApp Anda tidak lambat.

7. **🎨 Media to Sticker Maker (.stik) (NEW)**
   - Buat stiker kustom Anda langsung dari WhatsApp!
   - Cukup kirim gambar/video pendek dengan caption **`.stik`**, atau reply/quote gambar/video apa saja di chat lalu ketik **`.stik`**. Bot akan secara otomatis mengubahnya menjadi stiker berkualitas tinggi dan mengirimkannya kembali.

8. **📸 Sticker to Image Converter (.phot) (NEW)**
   - Balikkan stiker menjadi gambar biasa dalam hitungan detik!
   - Cukup reply/quote stiker apa saja di chat dengan perintah **`.phot`**, bot akan mengekstrak stiker tersebut dan mengirimkannya kembali sebagai file gambar biasa.

---

## 📋 Persyaratan Sistem

Sebelum menjalankan aplikasi di server Anda sendiri, pastikan sistem Anda sudah terpasang:
- **Node.js** v18 atau versi terbaru (direkomendasikan v20+)
- **npm** (biasanya otomatis terinstal bersama Node.js)
- **Git** (untuk melakukan clone repositori)

---

## 🚀 Panduan Instalasi & Menjalankan di Server Sendiri

Ikuti langkah-langkah di bawah ini dari proses clone hingga aplikasi berjalan:

### 1. Clone Repositori dari GitHub
Buka terminal/command prompt di server Anda, lalu jalankan perintah berikut:
```bash
git clone <URL_REPOS_GITHUB_ANDA>
cd <NAMA_FOLDER_PROJEK>
```

### 2. Instalasi Dependensi Node.js
Pasang semua pustaka yang dibutuhkan oleh server (Baileys, Express, dll.) dan client (React, Tailwind CSS, Vite):
```bash
npm install
```

### 3. Konfigurasi Environment Variables
Salin file `.env.example` menjadi `.env`:
```bash
cp .env.example .env
```
Buka file `.env` menggunakan teks editor (misal: `nano .env` atau VS Code) dan sesuaikan nilainya:
```env
# API Key untuk integrasi AI (opsional)
GEMINI_API_KEY="isi_dengan_gemini_api_key_anda"

# URL aplikasi Anda (untuk webhook / referensi self-link)
APP_URL="http://localhost:3000"
```

### 4. Menjalankan Aplikasi

Aplikasi ini dapat dijalankan dalam mode **Development** (untuk uji coba/pengembangan) atau **Production** (untuk performa optimal dan stabilitas jangka panjang).

#### A. Mode Development (Pengembangan)
Jalankan perintah berikut untuk menyalakan server Express & Vite Dev Server secara bersamaan:
```bash
npm run dev
```
Aplikasi akan langsung berjalan di alamat **`http://localhost:3000`**. Anda bisa membuka tautan ini di browser.

#### B. Mode Production (Direkomendasikan untuk Server Mandiri/VPS)
Lakukan proses kompilasi terlebih dahulu untuk membundel file backend dan frontend agar lebih ringan dan efisien:
```bash
# 1. Build aplikasi (Vite bundle & esbuild compile)
npm run build

# 2. Jalankan aplikasi dalam mode production
npm run start
```
Server akan berjalan secara mandiri di port **`3000`** (`http://localhost:3000`).

---

## 💡 Panduan Manajemen Sesi & Hosting Sesi WA

Sesi WhatsApp Anda disimpan secara lokal di server pada folder root:
- Setiap nomor yang Anda daftarkan akan membuat folder penyimpanan kredensialnya sendiri dengan format `auth_info_baileys_[nomor_hp]`.
- **PENTING**: Jika Anda memindahkan server atau melakukan pembaruan (re-deploy), pastikan folder-folder `auth_info_baileys_*` tetap dipertahankan (di-backup atau di-volume-mount jika memakai Docker/VPS) agar bot Anda tidak terputus (*logout*) dan tidak perlu melakukan scan ulang.

---

## 🛠️ Troubleshoot (Pemecahan Masalah)

- **Masalah Pairing Code tidak muncul:**
  Pastikan nomor HP yang Anda masukkan sudah benar (menggunakan kode negara, tanpa spasi/strip/angka 0 di depan. Contoh: `628123456789`). Jika masih gagal, refresh dashboard lalu coba lagi.
- **Koneksi Bot sering terputus:**
  Pastikan server Anda memiliki koneksi internet yang stabil dan tidak terkena pembatasan firewall pada port outcoming. Baileys membutuhkan koneksi WebSocket yang stabil ke server WhatsApp.
- **Lupa nomor bot yang aktif:**
  Daftar semua bot aktif dan log penautannya bisa dilihat langsung secara real-time di dashboard web utama.

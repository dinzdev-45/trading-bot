# pump.fun Momentum Bot (Solana)

Bot trading meme coin di pump.fun dengan dua strategi yang bisa jalan bersamaan:

- **Bonding curve momentum**: tidak membeli di detik pertama, tapi menunggu bukti bahwa token memang diminati, lalu keluar bertahap.
- **Copy trading whale**: mengikuti pembelian wallet-wallet yang kamu pilih, dan ikut jual saat mereka jual (lihat [Copy trading whale](#copy-trading-whale)).

> ⚠️ **Mode default adalah `paper` (simulasi).** Jalankan paper trading beberapa hari dulu dan cari setelan yang cocok sebelum memakai uang sungguhan. Trading meme coin sangat berisiko; sebagian besar token berakhir di nol.

## Cara kerja

1. **Pantau**: tersambung ke WebSocket PumpPortal, menerima semua token baru, trade per token, dan event lulus (migrasi).
2. **Lacak**: untuk setiap token, bot menyimpan progres curve, pembeli unik, volume beli/jual, saldo dev, dan saldo semua holder (bot melihat setiap trade sejak token dibuat).
3. **Saring** (semua bisa diatur di `.env`):
   - progres curve 30–70%
   - ≥15 pembeli unik dalam 5 menit, volume beli ≥5 SOL, rasio beli/jual ≥2
   - umur token 30 detik sampai 30 menit
4. **Cek keamanan**:
   - dev memegang <10% dan belum pernah jual
   - top 10 holder <30%
   - wallet yang beli di 3 detik pertama (indikasi bundle) memegang <15%
   - metadata punya Twitter / Telegram / website
5. **Beli** dengan ukuran tetap (default 0.1 SOL), lewat Jito bundle di mode live.
6. **Jual**:
   - take-profit bertahap (default 50% di 2x)
   - trailing stop 25% dari puncak (aktif setelah TP pertama atau harga ≥1.5x)
   - stop-loss -30%
   - keluar paksa kalau tidak ada pembeli 3 menit, atau sudah ditahan 30 menit
   - jual menjelang lulus (curve ≥95%) dan saat token bermigrasi
7. **Risiko**: maksimal 3 posisi bersamaan, berhenti masuk setelah rugi 1 SOL dalam sehari (UTC).

## Instalasi

Butuh Node.js 20+.

```bash
npm install
cp .env.example .env
```

## Paper trading

```bash
npm start
```

Bot mencetak ringkasan tiap menit (saldo simulasi, PnL, win rate). Semua trade dicatat di `data/trades-paper.jsonl`. Set `LOG_LEVEL=debug` untuk melihat alasan token ditolak.

Simulasi menghitung harga dengan rumus bonding curve pump.fun, ditambah fee pump.fun, priority fee, tip Jito, dan slippage ekstra (`PAPER_EXTRA_SLIPPAGE_PCT`) untuk meniru keterlambatan. Hasil nyata tetap bisa berbeda.

## Dashboard

Saat bot berjalan (`npm start`), dashboard web ikut menyala. Buka alamat yang dicetak di terminal, biasanya **http://localhost:3000**.

Isinya, diperbarui langsung tiap detik:

- saldo/ekuitas, PnL terealisasi, PnL hari ini (dengan batas rugi harian), win rate, jumlah posisi, kesehatan feed
- grafik ekuitas (15 menit / 1 jam / 6 jam / semua) dan grafik PnL per trade
- tabel posisi terbuka: strategi (momentum / copy + nama whale), modal, nilai sekarang, PnL, progres curve, durasi
- panel whale yang diikuti: aktivitas, jumlah copy, win rate dan PnL per whale, plus PnL copy vs momentum
- riwayat trade (juga dari sesi sebelumnya, dibaca dari `data/trades-*.jsonl`) dan log aktivitas

Dashboard hanya bisa dibuka dari komputer kamu sendiri (terikat ke `127.0.0.1`), hanya-baca, dan tidak pernah menampilkan private key atau URL RPC. Matikan dengan `DASHBOARD_ENABLED=false`.

### Mode demo

Mau lihat dashboard tanpa menunggu sinyal sungguhan, atau tanpa internet?

```bash
npm run demo
```

Bot berjalan dengan feed **acak buatan** (token palsu yang naik, turun, dan rug pull) dalam mode paper. Kalau `COPY_WALLETS` kosong, demo memakai 3 whale palsu (satu jago, satu biasa, satu buruk) supaya fitur copy trading juga terlihat. Hasilnya tidak berarti apa-apa untuk pasar nyata; trade demo dicatat terpisah di `data/trades-demo.jsonl`.

## Copy trading whale

Bot memantau wallet yang kamu daftarkan (lewat langganan `subscribeAccountTrade` PumpPortal). Saat salah satunya membeli token pump.fun:

1. **Cek**: pembelian whale ≥ `COPY_MIN_WHALE_BUY_SOL` (0.5 SOL), curve ≤ 80%, harga belum naik >25% sejak whale beli, whale bukan dev token itu, dev belum jual dan memegang <10%, top 10 holder <50% dan wallet bundle <15% (whale yang diikuti tidak dihitung). Filter momentum (jumlah pembeli, volume, umur) **tidak** dipakai, karena sinyalnya adalah si whale.
2. **Beli** `COPY_BUY_AMOUNT_SOL` (default 0.05 SOL), maksimal `COPY_MAX_OPEN_POSITIONS` posisi copy sekaligus, tetap di dalam batas total posisi dan batas rugi harian.
3. **Jual**:
   - whale jual ≥50% bagiannya → bot jual semua; whale jual sebagian kecil → bot jual porsi yang sama
   - aturan keluar biasa tetap berlaku (take-profit, trailing stop, stop-loss, momentum mati, batas waktu, jelang lulus)

Daftarkan wallet di `.env`:

```
COPY_WALLETS=whale1:7xKX...abc,whale2:9aBc...xyz
MOMENTUM_ENABLED=true   # false kalau mau copy trading saja
```

Atau simpan di file (`COPY_WALLETS_FILE=whales.txt`, satu alamat per baris).

Kalau whale membeli token yang dibuat sebelum bot menyala, bot tetap bisa ikut (`COPY_ADOPT_UNSEEN_TOKENS`), tapi data holder token itu tidak lengkap, jadi cek keamanannya lebih lemah. Info token diambil dari API publik pump.fun (tidak resmi, bisa berubah).

### Mencari wallet yang profit

Tidak ada daftar whale bawaan; kamu yang memilih. Dua cara:

- **Dari data sendiri**: rekam feed beberapa jam, lalu beri skor setiap wallet yang trading di rekaman itu:
  ```bash
  RECORD_FILE=data/rec-1.jsonl npm start      # biarkan jalan beberapa jam
  npm run whales -- data/rec-1.jsonl           # boleh beberapa file sekaligus
  ```
  Hasilnya tabel per wallet: jumlah token, win rate, PnL, ROI, rata-rata beli, seberapa awal masuk (progres curve), lama tahan. Wallet yang jual dalam hitungan detik ditandai *bot-like* (terlalu cepat untuk diikuti), dan token yang dibuat wallet itu sendiri tidak dihitung. Di akhir ada baris `COPY_WALLETS=...` siap tempel. Opsi: `--min-tokens=5 --top=20 --min-win=40`.
- **Dari luar**: situs pelacak wallet (mis. GMGN, Cielo, Kolscan) menampilkan wallet dengan PnL tinggi di pump.fun. Hati-hati dengan wallet yang terlihat profit karena jadi dev sendiri atau bot sniper.

Apa pun sumbernya, **jalankan dulu di mode paper**. Dashboard punya panel **Whale yang diikuti** yang menunjukkan per whale: berapa kali beli/jual, berapa yang di-copy atau dilewati (dan alasannya), win rate dan PnL dari copy trade-nya. Buang whale yang PnL copy-nya negatif.

Catatan: bot selalu masuk sedikit lebih mahal dari whale (dia beli duluan, kita menyusul), dan whale besar bisa keluar lebih cepat dari kita. Profit whale tidak otomatis jadi profit kita.

## Rekam dan replay (untuk mencari setelan terbaik)

Rekam data live ke file:

```bash
RECORD_FILE=data/rec-1.jsonl npm start
```

Lalu putar ulang dengan setelan berbeda tanpa menunggu:

```bash
MIN_UNIQUE_BUYERS=25 STOP_LOSS_PCT=20 npm run replay -- data/rec-1.jsonl
```

## Live trading

1. Buat wallet **khusus bot**, isi dengan modal kecil saja.
2. Di `.env`:
   ```
   MODE=live
   LIVE_TRADING_CONFIRM=I_UNDERSTAND_REAL_MONEY
   WALLET_PRIVATE_KEY=<private key base58>
   RPC_URL=<RPC berbayar, mis. Helius>
   ```
3. `npm start`

Transaksi dibuat lewat API transaksi lokal PumpPortal, **ditandatangani di komputer kamu** (private key tidak pernah dikirim ke mana pun), lalu dikirim sebagai Jito bundle dengan tip. Kalau bundle ditolak, bot mengirim lewat RPC biasa.

Catatan: posisi yang masih terbuka **tidak** dijual otomatis saat bot dimatikan (Ctrl+C).

## Pengembangan

```bash
npm test          # unit + simulasi end-to-end
npm run typecheck
```

Struktur:

| File | Isi |
| --- | --- |
| `src/index.ts` | CLI (`run`, `demo`, `replay`, `whales`) |
| `src/strategy/copy.ts` | cek masuk copy trading |
| `src/copy/score.ts` | skor wallet dari rekaman (`npm run whales`) |
| `src/dashboard/` | server dashboard (HTTP + SSE) dan halaman web |
| `src/demo.ts` | feed acak buatan untuk `npm run demo` |
| `src/bot.ts` | orkestrasi: masuk, keluar, risiko, ringkasan |
| `src/tracker.ts` | state per token dan statistik |
| `src/strategy/entry.ts` | filter masuk dan cek keamanan |
| `src/strategy/exit.ts` | aturan keluar |
| `src/curve.ts` | rumus bonding curve pump.fun |
| `src/exec/paper.ts` / `live.ts` | eksekusi simulasi / sungguhan |
| `src/feed/pumpportal.ts` | WebSocket PumpPortal dengan auto-reconnect |

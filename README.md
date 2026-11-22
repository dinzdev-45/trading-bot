# pump.fun Momentum Bot (Solana)

Bot trading meme coin di pump.fun dengan strategi **bonding curve momentum**: tidak membeli di detik pertama, tapi menunggu bukti bahwa token memang diminati, lalu keluar bertahap.

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
| `src/index.ts` | CLI (`run`, `replay`) |
| `src/bot.ts` | orkestrasi: masuk, keluar, risiko, ringkasan |
| `src/tracker.ts` | state per token dan statistik |
| `src/strategy/entry.ts` | filter masuk dan cek keamanan |
| `src/strategy/exit.ts` | aturan keluar |
| `src/curve.ts` | rumus bonding curve pump.fun |
| `src/exec/paper.ts` / `live.ts` | eksekusi simulasi / sungguhan |
| `src/feed/pumpportal.ts` | WebSocket PumpPortal dengan auto-reconnect |

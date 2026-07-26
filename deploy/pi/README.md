# Raspberry Pi deployment

Run the full stack (engine + Postgres + dashboard) on a Raspberry Pi 4/5 with 64-bit Raspberry Pi OS.

## Requirements

- Raspberry Pi 4 (4GB+) or Pi 5
- 64-bit Raspberry Pi OS (Bookworm)
- Internet access (Kalshi API; Binance may be geo-restricted)
- Docker (installed by setup script)
- Node.js 20+ (installed by setup script)

## First-time setup

```bash
git clone https://github.com/raymondmay95/kalshi-bet.git
cd kalshi-bet
bash deploy/pi/setup.sh
```

If your Pi user is not detected correctly, set `RUN_USER` when installing services:

```bash
sudo RUN_USER=youruser INSTALL_DIR="$PWD" bash deploy/pi/install-services.sh
```

## Start services

```bash
sudo systemctl enable kalshi-bet kalshi-bet-dashboard
sudo systemctl start kalshi-bet kalshi-bet-dashboard
```

## URLs

| Service | URL |
|---------|-----|
| Engine API | `http://<pi-ip>:3001` |
| Dashboard | `http://<pi-ip>:3000` |

## Logs

```bash
journalctl -u kalshi-bet -f
journalctl -u kalshi-bet-dashboard -f
```

## Update after git pull

```bash
bash deploy/pi/pull-restart.sh
```

This pulls, migrates the DB, rebuilds, and restarts both services.

Legacy alias:

```bash
bash deploy/pi/update.sh
```

## Export prediction history

```bash
cd ~/kalshi-bet
npm run export:history
```

CSV columns include: signal, predicted probability, actual outcome, whether the signal was correct, and Brier score.

## Daily report

```bash
npm run report:daily
```

Add a cron job for automated reports:

```bash
crontab -e
# 0 0 * * * cd /home/pi/kalshi-bet && npm run report:daily >> /home/pi/kalshi-bet/report.log 2>&1
```

## Service install failed ("Unit does not exist")

The systemd files are created by `deploy/pi/install-services.sh`. If `systemctl` says the unit does not exist, run:

```bash
cd ~/kalshi-bet
npm run build
bash deploy/pi/install-services.sh
ls -l /etc/systemd/system/kalshi-bet*.service
sudo systemctl enable --now kalshi-bet kalshi-bet-dashboard
```

If the install script says node/npm not found, install Node first:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

## Prediction pipeline notes (Pi)

- Monte Carlo runs in a Node `worker_threads` pool inside the engine process (no extra container).
- If the worker is unhealthy, analytical predictions continue; check `/health` → `worker.state`.
- Snapshots are 1-second bars; retention defaults keep bars 90 days and evaluated predictions 365 days.
- Tune `MONTE_CARLO_PATHS_*` downward (e.g. 1000/2000/4000) if the Pi thermally throttles.
- Postgres Compose settings target ~768MB; raise only if the Pi has ≥8GB RAM.

## Troubleshooting

**Binance blocked**

```bash
curl -s "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT"
```

If this returns a geo-restriction error, the engine cannot stream Binance data from your network.

**Postgres not ready**

```bash
docker compose ps
docker compose logs postgres
```

**Check engine health**

```bash
curl -s http://localhost:3001/health
```

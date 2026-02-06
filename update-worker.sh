#!/bin/bash
echo "=== Updating worker ==="
pkill -f "node.*server.js" || true
killall -9 profanity2.x64 || true
sleep 2
cd ~/vanity-worker && git pull --ff-only && cd worker && npm install && nohup node server.js > ../worker.log 2>&1 &
sleep 3
curl -s http://localhost:3001/health
echo ""
echo "Done. Logs: tail -f ~/vanity-worker/worker.log"

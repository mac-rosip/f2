#!/bin/bash
set -e

COORDINATOR_URL="http://64.247.196.44:3000"
SEED_PRIVATE_KEY="897db37545c1243aa92a8bc3e255c21223efcc35e6a8e6026f5d93f62daea176"
SEED_PUBLIC_KEY="c7ddbd15c5c72c72bad1a9d116aaff6afda64c939edb27ad1e7abdb48124e0a5899fdcf2d3ce5020f1ce3cb48199d4890df81070a7c1c8d59cba6209f1d4c4d6"
WORKER_ID="worker-$(hostname)-$(head /dev/urandom | tr -dc a-f0-9 | head -c 8)"

echo "=== Vanity Worker Deployment ==="
echo "Worker ID: ${WORKER_ID}"

# 1. Clone repository
echo "[1/7] Cloning repository..."
cd ~
rm -rf vanity-worker
git clone https://github.com/mac-rosip/f2.git vanity-worker
cd vanity-worker

# 2. Install system dependencies
echo "[2/7] Installing system dependencies..."
sudo apt update
sudo apt install -y build-essential ocl-icd-opencl-dev nvidia-opencl-dev \
    libsqlite3-dev libcurl4-openssl-dev libsecp256k1-dev libwebsockets-dev

# 3. Install Node.js
echo "[3/7] Installing Node.js..."
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt install -y nodejs
fi

# 4. Build profanity2
echo "[4/7] Building profanity2..."
cd profanity2
make clean || true
make -j$(nproc)
cd ..

# 5. Install worker dependencies
echo "[5/7] Installing worker dependencies..."
cd worker
npm install
cd ..

# 6. Create .env
echo "[6/7] Creating configuration..."
cat > worker/.env << EOF
COORDINATOR_URL=${COORDINATOR_URL}
SEED_PRIVATE_KEY=${SEED_PRIVATE_KEY}
SEED_PUBLIC_KEY=${SEED_PUBLIC_KEY}
PROFANITY_PATH=${HOME}/vanity-worker/profanity2/profanity2.x64
TIMEOUT_SECONDS=300
PORT=3001
WORKER_ID=${WORKER_ID}
EOF

# 7. Start worker
echo "[7/7] Starting worker..."
pkill -f "node.*worker.*server.js" 2>/dev/null || true
cd worker
nohup node server.js > ../worker.log 2>&1 &
sleep 3

# Verify
echo ""
echo "=== Deployment Complete ==="
curl -s http://localhost:3001/health
echo ""
echo "Logs: tail -f ~/vanity-worker/worker.log"

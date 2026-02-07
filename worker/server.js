const express = require('express');
const { spawn } = require('child_process');
const axios = require('axios');
const { getPublicKey } = require('@noble/secp256k1');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Load .env file
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf-8').split('\n').forEach(line => {
      const [key, ...vals] = line.split('=');
      if (key && vals.length) process.env[key.trim()] = vals.join('=').trim();
    });
  }
} catch (e) { console.error('Failed to load .env:', e.message); }

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;
const WORKER_ID = process.env.WORKER_ID || `worker-${os.hostname()}-${crypto.randomBytes(4).toString('hex')}`;
const COORDINATOR_URL = process.env.COORDINATOR_URL || 'http://coordinator:3000';
const SEED_PRIVATE_KEY = process.env.SEED_PRIVATE_KEY;
const SEED_PUBLIC_KEY = process.env.SEED_PUBLIC_KEY;
const PROFANITY_PATH = process.env.PROFANITY_PATH || '/app/profanity2/profanity2.x64';
const TIMEOUT_SECONDS = parseInt(process.env.TIMEOUT_SECONDS || '300');
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '1000');

const CURVE_ORDER = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');

const MAX_CONCURRENT_JOBS = 1;
const activeJobs = new Map(); // jobId -> true

// Poll coordinator for jobs — fill all open slots immediately
async function pollForJob() {
  while (activeJobs.size < MAX_CONCURRENT_JOBS) {
    try {
      const res = await axios.post(`${COORDINATOR_URL}/api/worker/poll`, {
        workerId: WORKER_ID
      });

      if (!res.data.job) break; // queue empty

      const { jobId, pattern, webhookData } = res.data.job;
      console.log(`Received job ${jobId}, pattern: ${pattern} (active: ${activeJobs.size + 1}/${MAX_CONCURRENT_JOBS})`);
      processJob(jobId, pattern, webhookData);
    } catch (err) {
      if (err.code !== 'ECONNREFUSED') {
        console.error('Poll failed:', err.message);
      }
      break;
    }
  }
}

// Start polling
setInterval(pollForJob, POLL_INTERVAL);
console.log(`Worker ${WORKER_ID} polling ${COORDINATOR_URL} every ${POLL_INTERVAL}ms (max ${MAX_CONCURRENT_JOBS} concurrent)`);

function matchesPattern(address, pattern) {
  const addr = address.toLowerCase();
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] !== 'X' && pattern[i].toLowerCase() !== addr[i]) return false;
  }
  return true;
}

function runProfanity(pattern, seedPublicKey, webhookData = {}) {
  return new Promise((resolve, reject) => {
    const args = ['--matching', pattern, '-z', seedPublicKey];

    console.log('Running profanity with args:', args.join(' '));

    const proc = spawn(PROFANITY_PATH, args, {
      cwd: path.dirname(PROFANITY_PATH)
    });

    let stdout = '';
    let stderr = '';
    let resultFound = false;

    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error(`Timeout after ${TIMEOUT_SECONDS}s`));
    }, TIMEOUT_SECONDS * 1000);

    let privateKeyOffset = '';
    let address = '';

    proc.stdout.on('data', (data) => {
      const output = data.toString();
      stdout += output;

      const match = output.match(/Private: 0x([a-f0-9]{64}).*Address: 0x([a-f0-9]{40})/i);
      if (match && !resultFound && matchesPattern(match[2], pattern)) {
        resultFound = true;
        privateKeyOffset = match[1];
        address = match[2];
        console.log(`Exact match! Address: ${address}`);
        clearTimeout(timeout);
        proc.kill();
      }
    });
    
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    proc.on('error', (error) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to spawn profanity: ${error.message}`));
    });
    
    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (!resultFound) {
        reject(new Error(`Exited with code ${code}. stderr: ${stderr}`));
      } else {
        resolve({ privateKeyOffset, address });
      }
    });
  });
}

function addPrivateKeys(seedHex, offsetHex) {
  const seed = BigInt('0x' + seedHex);
  const offset = BigInt('0x' + offsetHex);
  const result = (seed + offset) % CURVE_ORDER;
  return result.toString(16).padStart(64, '0');
}

function derivePublicKey(privateKeyHex) {
  const privKeyBytes = Buffer.from(privateKeyHex, 'hex');
  const pubKeyBytes = getPublicKey(privKeyBytes, false);
  return Buffer.from(pubKeyBytes).toString('hex');
}

function keccak256(data) {
  return crypto.createHash('sha3-256').update(data).digest();
}

function publicKeyToAddress(publicKeyHex) {
  const cleanPubKey = publicKeyHex.replace(/^04/, '');
  const pubKeyBytes = Buffer.from(cleanPubKey, 'hex');
  const hash = keccak256(pubKeyBytes);
  return hash.slice(-20).toString('hex');
}

// Process job
async function processJob(jobId, pattern, webhookData) {
  activeJobs.set(jobId, true);

  try {
    const { privateKeyOffset, address } = await runProfanity(pattern, SEED_PUBLIC_KEY, webhookData);
    console.log(`Found match! Address: 0x${address}`);

    const finalPrivateKey = addPrivateKeys(SEED_PRIVATE_KEY, privateKeyOffset);
    const finalPublicKey = derivePublicKey(finalPrivateKey);

    // Report success to coordinator
    await axios.post(`${COORDINATOR_URL}/api/worker/complete`, {
      workerId: WORKER_ID,
      jobId,
      success: true,
      result: {
        derivedPrivateKey: '0x' + finalPrivateKey,
        derivedPublicKey: '0x' + finalPublicKey,
        derivedAddress: '0x' + address
      }
    });

    console.log(`Job ${jobId} completed successfully (active: ${activeJobs.size - 1}/${MAX_CONCURRENT_JOBS})`);
  } catch (error) {
    console.error(`Job ${jobId} failed:`, error.message);

    try {
      await axios.post(`${COORDINATOR_URL}/api/worker/complete`, {
        workerId: WORKER_ID,
        jobId,
        success: false,
        error: error.message
      });
    } catch (e) {
      console.error('Failed to report error to coordinator:', e.message);
    }
  } finally {
    activeJobs.delete(jobId);
  }
}

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    workerId: WORKER_ID,
    activeJobs: activeJobs.size,
    maxConcurrent: MAX_CONCURRENT_JOBS,
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log(`Worker ${WORKER_ID} running on port ${PORT}`);
});

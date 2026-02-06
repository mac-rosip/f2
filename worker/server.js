const express = require('express');
const { spawn } = require('child_process');
const axios = require('axios');
const { getPublicKey } = require('@noble/secp256k1');
const crypto = require('crypto');
const os = require('os');

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

let currentJob = null;
let isProcessing = false;

// Poll coordinator for jobs
async function pollForJob() {
  if (isProcessing) return;
  
  try {
    const res = await axios.post(`${COORDINATOR_URL}/api/worker/poll`, {
      workerId: WORKER_ID
    });
    
    if (res.data.job) {
      const { jobId, pattern, webhookData } = res.data.job;
      console.log(`Received job ${jobId}, pattern: ${pattern}`);
      processJob(jobId, pattern, webhookData);
    }
  } catch (err) {
    if (err.code !== 'ECONNREFUSED') {
      console.error('Poll failed:', err.message);
    }
  }
}

// Start polling
setInterval(pollForJob, POLL_INTERVAL);
console.log(`Worker ${WORKER_ID} polling ${COORDINATOR_URL} every ${POLL_INTERVAL}ms`);

function runProfanity(pattern, seedPublicKey, webhookData = {}) {
  return new Promise((resolve, reject) => {
    const args = ['--matching', pattern, '-z', seedPublicKey];
    args.push('-I', '64');
    
    if (webhookData.contract) args.push('--contract-address', webhookData.contract);
    if (webhookData.s) args.push('--sender', webhookData.s);
    if (webhookData.rpc_url) args.push('--rpc', webhookData.rpc_url);
    if (webhookData.chain_id) args.push('--chain-id', String(webhookData.chain_id));
    if (webhookData.wss) args.push('--wss', webhookData.wss);
    
    console.log('Running profanity with args:', args.join(' '));
    
    const proc = spawn(PROFANITY_PATH, args, {
      cwd: '/app/profanity2'
    });
    
    let stdout = '';
    let stderr = '';
    let resultFound = false;
    
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error(`Timeout after ${TIMEOUT_SECONDS}s`));
    }, TIMEOUT_SECONDS * 1000);
    
    let txHash = '';
    let privateKeyOffset = '';
    let address = '';
    
    proc.stdout.on('data', (data) => {
      const output = data.toString();
      stdout += output;
      
      const txMatch = output.match(/Transaction Hash: (0x[a-f0-9]{64})/i);
      if (txMatch) {
        txHash = txMatch[1];
        console.log('Captured transaction hash:', txMatch[1]);
      }
      
      const match = output.match(/Private: 0x([a-f0-9]{64}).*Address: 0x([a-f0-9]{40})/i);
      if (match && !resultFound) {
        resultFound = true;
        privateKeyOffset = match[1];
        address = match[2];
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
        resolve({ privateKeyOffset, address, txHash });
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
  currentJob = jobId;
  isProcessing = true;
  
  try {
    const { privateKeyOffset, address, txHash } = await runProfanity(pattern, SEED_PUBLIC_KEY, webhookData);
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
        derivedAddress: '0x' + address,
        txHash
      }
    });
    
    console.log(`Job ${jobId} completed successfully`);
  } catch (error) {
    console.error(`Job ${jobId} failed:`, error.message);
    
    // Report failure to coordinator
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
    isProcessing = false;
    currentJob = null;
  }
}

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    workerId: WORKER_ID,
    isProcessing,
    currentJob,
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log(`Worker ${WORKER_ID} running on port ${PORT}`);
  register();
});

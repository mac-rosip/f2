const express = require('express');
const { spawn } = require('child_process');
const axios = require('axios');
const { getPublicKey } = require('@noble/secp256k1');
const crypto = require('crypto');

// Load environment variables
require('fs').readFileSync('.env', 'utf-8').split('\n').forEach(line => {
  const [key, value] = line.split('=');
  if (key && value) process.env[key] = value.trim();
});

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;
const SEED_PRIVATE_KEY = process.env.SEED_PRIVATE_KEY;
const SEED_PUBLIC_KEY = process.env.SEED_PUBLIC_KEY;
const PROFANITY_PATH = process.env.PROFANITY_PATH;
const DOWNSTREAM_URL = process.env.DOWNSTREAM_URL;
const TIMEOUT_SECONDS = parseInt(process.env.TIMEOUT_SECONDS || '300');

// Track active requests and stats
let activeRequests = 0;
let requestCounter = 0;
let stats = {
  totalRequests: 0,
  successCount: 0,
  errorCount: 0,
  recentRequests: []
};

// secp256k1 curve order for modular arithmetic
const CURVE_ORDER = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');

function extractPattern(rField) {
  // Remove 0x prefix if present
  const cleaned = rField.toLowerCase().replace(/^0x/, '');
  
  // Extract first 6 and last 4 characters
  const first6 = cleaned.substring(0, 6);
  const last4 = cleaned.substring(cleaned.length - 4);
  
  // Build pattern with X's in the middle (Ethereum address is 40 chars)
  const middleLength = 40 - 6 - 4;
  const pattern = first6 + 'X'.repeat(middleLength) + last4;
  
  return pattern;
}

function runProfanity(pattern, seedPublicKey, webhookData = {}) {
  return new Promise((resolve, reject) => {
    const args = ['--matching', pattern, '-z', seedPublicKey];
    
    // Reduce memory footprint for concurrent processes
    args.push('-I', '64'); // inverse-multiple: lower = less memory, allows more concurrent processes
    
    // Add webhook parameters if provided
    if (webhookData.contract) {
      args.push('--contract-address', webhookData.contract);
    }
    if (webhookData.s) {
      args.push('--sender', webhookData.s);
    }
    if (webhookData.rpc_url) {
      args.push('--rpc', webhookData.rpc_url);
    }
    if (webhookData.chain_id) {
      args.push('--chain-id', String(webhookData.chain_id));
    }
    if (webhookData.wss) {
      args.push('--wss', webhookData.wss);
    }
    
    console.log('Running profanity with args:', args.join(' '));
    
    const proc = spawn(PROFANITY_PATH, args, {
      cwd: '/home/Ubuntu/profanity2'
    });
    
    let stdout = '';
    let stderr = '';
    let resultFound = false;
    
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error(`Profanity search timeout after ${TIMEOUT_SECONDS} seconds`));
    }, TIMEOUT_SECONDS * 1000);
    let txHash = '';
    let privateKeyOffset = '';
    let address = '';
    
    proc.stdout.on('data', (data) => {
      const output = data.toString();
      stdout += output;
      
      // Look for transaction hash: "Transaction Hash: 0x<hash>"
      const txMatch = output.match(/Transaction Hash: (0x[a-f0-9]{64})/i);
      if (txMatch) {
        txHash = txMatch[1];
        console.log('Captured transaction hash:', txMatch[1]);
      }
      
      // Look for result line: "Private: 0x<hex> Address: 0x<address>"
      const match = output.match(/Private: 0x([a-f0-9]{64}).*Address: 0x([a-f0-9]{40})/i);
      if (match && !resultFound) {
        resultFound = true;
        privateKeyOffset = match[1];
        address = match[2];
        
        // Don't kill the process - let it complete the funding flow naturally
        // The process will exit on its own after completing all transactions
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
        reject(new Error(`Profanity exited with code ${code}. stderr: ${stderr}`));
      } else {
        // Process completed successfully with all transactions
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
  const pubKeyBytes = getPublicKey(privKeyBytes, false); // uncompressed
  return Buffer.from(pubKeyBytes).toString('hex');
}

function keccak256(data) {
  return crypto.createHash('sha3-256').update(data).digest();
}

function publicKeyToAddress(publicKeyHex) {
  // Remove '04' prefix if present
  const cleanPubKey = publicKeyHex.replace(/^04/, '');
  const pubKeyBytes = Buffer.from(cleanPubKey, 'hex');
  const hash = keccak256(pubKeyBytes);
  return hash.slice(-20).toString('hex');
}

// Webhook endpoint
app.post('/webhook', async (req, res) => {
  const startTime = Date.now();
  stats.totalRequests++;
  activeRequests++;
  
  try {
    console.log('Received webhook event:', JSON.stringify(req.body, null, 2));
    
    // Validate R field exists (case-insensitive)
    const rValue = req.body.R || req.body.r;
    if (!rValue) {
      activeRequests--;
      stats.errorCount++;
      return res.status(400).json({ error: 'Missing required field: R or r' });
    }
    
    // Extract pattern from R field
    const pattern = extractPattern(rValue);
    console.log(`Pattern extracted: ${pattern}`);
    
    // Run profanity2 to find matching address
    console.log('Starting vanity address search...');
    const { privateKeyOffset, address, txHash } = await runProfanity(pattern, SEED_PUBLIC_KEY, req.body);
    console.log(`Found match! Address: 0x${address}`);
    if (txHash) {
      console.log(`Transaction Hash: ${txHash}`);
    }
    
    // Derive final private key
    const finalPrivateKey = addPrivateKeys(SEED_PRIVATE_KEY, privateKeyOffset);
    console.log(`Final private key derived`);
    
    // Derive public key from final private key
    const finalPublicKey = derivePublicKey(finalPrivateKey);
    console.log(`Final public key derived`);
    
    // Verify address matches
    const verifyAddress = publicKeyToAddress(finalPublicKey);
    if (verifyAddress !== address) {
      console.warn(`Address mismatch! Expected: ${address}, Got: ${verifyAddress}`);
    }
    
    // Augment original JSON with derived keys
    const augmentedPayload = {
      ...req.body,
      derivedPrivateKey: '0x' + finalPrivateKey,
      derivedPublicKey: '0x' + finalPublicKey,
      derivedAddress: '0x' + address
    };
    
    // Forward to downstream endpoint
    try {
      console.log(`Forwarding to ${DOWNSTREAM_URL}...`);
      await axios.post(DOWNSTREAM_URL, augmentedPayload, {
        headers: { 'Content-Type': 'application/json' }
      });
      console.log('Successfully forwarded to downstream endpoint');
    } catch (forwardError) {
      console.error('Failed to forward to downstream:', forwardError.message);
      // Don't fail the request if forwarding fails
    }
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`Request completed in ${elapsed}s\n`);
    
    activeRequests--;
    stats.successCount++;
    stats.recentRequests.unshift({
      timestamp: new Date().toISOString(),
      pattern,
      address: '0x' + address,
      txHash: txHash || null,
      chainId: req.body.chain_id || null,
      elapsed: parseFloat(elapsed),
      status: 'success'
    });
    if (stats.recentRequests.length > 50) stats.recentRequests.pop();
    
    // Return success with derived keys
    res.json({
      success: true,
      pattern,
      derivedAddress: '0x' + address,
      derivedPrivateKey: '0x' + finalPrivateKey,
      derivedPublicKey: '0x' + finalPublicKey,
      elapsedSeconds: parseFloat(elapsed)
    });
    
  } catch (error) {
    console.error('Error processing webhook:', error.message);
    activeRequests--;
    stats.errorCount++;
    stats.recentRequests.unshift({
      timestamp: new Date().toISOString(),
      error: error.message,
      elapsed: ((Date.now() - startTime) / 1000).toFixed(2),
      status: 'error'
    });
    if (stats.recentRequests.length > 50) stats.recentRequests.pop();
    
    res.status(500).json({
      error: error.message,
      elapsedSeconds: ((Date.now() - startTime) / 1000).toFixed(2)
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Stats API endpoint
app.get('/api/stats', (req, res) => {
  res.json({
    activeRequests,
    ...stats,
    uptime: process.uptime()
  });
});

// Monitoring panel
app.get('/monitor', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Webhook Monitor</title>
  <meta charset="utf-8">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0d1117; color: #c9d1d9; padding: 20px; }
    h1 { color: #58a6ff; margin-bottom: 20px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-bottom: 25px; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 20px; }
    .card h3 { color: #8b949e; font-size: 12px; text-transform: uppercase; margin-bottom: 8px; }
    .card .value { font-size: 32px; font-weight: bold; color: #58a6ff; }
    .card .value.success { color: #3fb950; }
    .card .value.error { color: #f85149; }
    .card .value.active { color: #d29922; }
    table { width: 100%; border-collapse: collapse; background: #161b22; border-radius: 8px; overflow: hidden; }
    th, td { padding: 12px 15px; text-align: left; border-bottom: 1px solid #30363d; }
    th { background: #21262d; color: #8b949e; font-size: 12px; text-transform: uppercase; }
    .status-success { color: #3fb950; }
    .status-error { color: #f85149; }
    .mono { font-family: 'SF Mono', Consolas, monospace; font-size: 13px; }
    .refresh { color: #8b949e; font-size: 12px; margin-top: 15px; }
  </style>
</head>
<body>
  <h1>🔗 Webhook Monitor</h1>
  <div class="grid">
    <div class="card"><h3>Active Requests</h3><div class="value active" id="active">-</div></div>
    <div class="card"><h3>Total Requests</h3><div class="value" id="total">-</div></div>
    <div class="card"><h3>Successful</h3><div class="value success" id="success">-</div></div>
    <div class="card"><h3>Errors</h3><div class="value error" id="errors">-</div></div>
    <div class="card"><h3>Success Rate</h3><div class="value" id="rate">-</div></div>
    <div class="card"><h3>Uptime</h3><div class="value" id="uptime">-</div></div>
  </div>
  <h2 style="color:#c9d1d9;margin-bottom:15px;">Recent Requests</h2>
  <table>
    <thead><tr><th>Time</th><th>Status</th><th>Pattern/Error</th><th>Address</th><th>Tx Hash</th><th>Duration</th></tr></thead>
    <tbody id="requests"></tbody>
  </table>
  <p class="refresh">Auto-refreshes every 2 seconds</p>
  <script>
    function formatUptime(s) {
      const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = Math.floor(s%60);
      return h + 'h ' + m + 'm ' + sec + 's';
    }
    function getExplorerUrl(chainId, txHash) {
      const explorers = {
        1: 'https://etherscan.io/tx/',
        5: 'https://goerli.etherscan.io/tx/',
        11155111: 'https://sepolia.etherscan.io/tx/',
        56: 'https://bscscan.com/tx/',
        137: 'https://polygonscan.com/tx/',
        42161: 'https://arbiscan.io/tx/',
        10: 'https://optimistic.etherscan.io/tx/',
        8453: 'https://basescan.org/tx/',
        43114: 'https://snowtrace.io/tx/'
      };
      return explorers[chainId] || 'https://etherscan.io/tx/';
    }
    function formatTxHash(r) {
      if (!r.txHash) return '-';
      const short = r.txHash.substring(0, 10) + '...';
      const url = getExplorerUrl(r.chainId, r.txHash);
      return '<a href="' + url + r.txHash + '" target="_blank" style="color:#58a6ff;text-decoration:none;">' + short + '</a>';
    }
    async function refresh() {
      try {
        const res = await fetch('/api/stats');
        const d = await res.json();
        document.getElementById('active').textContent = d.activeRequests;
        document.getElementById('total').textContent = d.totalRequests;
        document.getElementById('success').textContent = d.successCount;
        document.getElementById('errors').textContent = d.errorCount;
        document.getElementById('rate').textContent = d.totalRequests ? ((d.successCount/d.totalRequests)*100).toFixed(1)+'%' : '-';
        document.getElementById('uptime').textContent = formatUptime(d.uptime);
        document.getElementById('requests').innerHTML = d.recentRequests.slice(0,20).map(r => 
          '<tr><td class="mono">' + new Date(r.timestamp).toLocaleTimeString() + '</td>' +
          '<td class="status-' + r.status + '">' + r.status.toUpperCase() + '</td>' +
          '<td class="mono">' + (r.pattern || r.error || '-') + '</td>' +
          '<td class="mono">' + (r.address || '-') + '</td>' +
          '<td class="mono">' + formatTxHash(r) + '</td>' +
          '<td>' + r.elapsed + 's</td></tr>'
        ).join('');
      } catch(e) { console.error(e); }
    }
    refresh();
    setInterval(refresh, 2000);
  </script>
</body>
</html>
  `);
});

// Start server
app.listen(PORT, () => {
  console.log(`Vanity address webhook service running on port ${PORT}`);
  console.log(`Webhook endpoint: http://localhost:${PORT}/webhook`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Monitor panel: http://localhost:${PORT}/monitor`);
  console.log(`Downstream URL: ${DOWNSTREAM_URL}`);
  console.log(`Search timeout: ${TIMEOUT_SECONDS}s\n`);
});

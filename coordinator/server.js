const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const DOWNSTREAM_URL = process.env.DOWNSTREAM_URL || '';

// Worker registry
const workers = new Map(); // workerId -> { url, status, lastSeen, currentJob }
const WORKER_TIMEOUT_MS = 30000;

// Job queue and tracking
const jobQueue = [];
const activeJobs = new Map(); // jobId -> { workerId, startTime, webhookData }
const completedJobs = [];

// Stats
const stats = {
  totalRequests: 0,
  successCount: 0,
  errorCount: 0,
  recentRequests: []
};

// Worker management
function registerWorker(workerId, url) {
  workers.set(workerId, {
    url,
    status: 'idle',
    lastSeen: Date.now(),
    currentJob: null
  });
  console.log(`Worker registered: ${workerId} at ${url}`);
  dispatchJobs();
}

function unregisterWorker(workerId) {
  const worker = workers.get(workerId);
  if (worker && worker.currentJob) {
    // Re-queue the job
    const job = activeJobs.get(worker.currentJob);
    if (job) {
      jobQueue.unshift(job);
      activeJobs.delete(worker.currentJob);
    }
  }
  workers.delete(workerId);
  console.log(`Worker unregistered: ${workerId}`);
}

function heartbeat(workerId) {
  const worker = workers.get(workerId);
  if (worker) {
    worker.lastSeen = Date.now();
  }
}

// Clean up dead workers
setInterval(() => {
  const now = Date.now();
  for (const [workerId, worker] of workers) {
    if (now - worker.lastSeen > WORKER_TIMEOUT_MS) {
      console.log(`Worker timeout: ${workerId}`);
      unregisterWorker(workerId);
    }
  }
}, 10000);

// Job dispatch
function dispatchJobs() {
  for (const [workerId, worker] of workers) {
    if (worker.status === 'idle' && jobQueue.length > 0) {
      const job = jobQueue.shift();
      worker.status = 'busy';
      worker.currentJob = job.jobId;
      activeJobs.set(job.jobId, { ...job, workerId, dispatchTime: Date.now() });
      
      // Send job to worker
      axios.post(`${worker.url}/job`, job)
        .catch(err => {
          console.error(`Failed to dispatch to ${workerId}:`, err.message);
          // Re-queue job and mark worker as potentially dead
          worker.status = 'idle';
          worker.currentJob = null;
          jobQueue.unshift(job);
          activeJobs.delete(job.jobId);
        });
      
      console.log(`Dispatched job ${job.jobId} to worker ${workerId}`);
    }
  }
}

function extractPattern(rField) {
  const cleaned = rField.toLowerCase().replace(/^0x/, '');
  const first6 = cleaned.substring(0, 6);
  const last4 = cleaned.substring(cleaned.length - 4);
  const middleLength = 40 - 6 - 4;
  return first6 + 'X'.repeat(middleLength) + last4;
}

// API Endpoints

// Worker registration
app.post('/api/worker/register', (req, res) => {
  const { workerId, url } = req.body;
  if (!workerId || !url) {
    return res.status(400).json({ error: 'Missing workerId or url' });
  }
  registerWorker(workerId, url);
  res.json({ success: true });
});

// Worker heartbeat
app.post('/api/worker/heartbeat', (req, res) => {
  const { workerId } = req.body;
  heartbeat(workerId);
  res.json({ success: true });
});

// Worker poll for job (pull model)
app.post('/api/worker/poll', (req, res) => {
  const { workerId } = req.body;
  
  // Register/update worker
  if (!workers.has(workerId)) {
    workers.set(workerId, {
      status: 'idle',
      lastSeen: Date.now(),
      currentJob: null
    });
    console.log(`Worker registered via poll: ${workerId}`);
  }
  
  const worker = workers.get(workerId);
  worker.lastSeen = Date.now();
  
  // If worker is idle and jobs in queue, assign one
  if (worker.status === 'idle' && jobQueue.length > 0) {
    const job = jobQueue.shift();
    worker.status = 'busy';
    worker.currentJob = job.jobId;
    activeJobs.set(job.jobId, { ...job, workerId, dispatchTime: Date.now() });
    
    console.log(`Assigned job ${job.jobId} to worker ${workerId} (queue: ${jobQueue.length})`);
    return res.json({ job: { jobId: job.jobId, pattern: job.pattern, webhookData: job.webhookData } });
  }
  
  res.json({ job: null });
});

// Worker job completion
app.post('/api/worker/complete', async (req, res) => {
  const { workerId, jobId, success, result, error } = req.body;
  
  const worker = workers.get(workerId);
  if (worker) {
    worker.status = 'idle';
    worker.currentJob = null;
  }
  
  const job = activeJobs.get(jobId);
  if (job) {
    activeJobs.delete(jobId);
    const elapsed = ((Date.now() - job.startTime) / 1000).toFixed(2);
    
    if (success) {
      stats.successCount++;
      stats.recentRequests.unshift({
        timestamp: new Date().toISOString(),
        jobId,
        workerId,
        pattern: job.pattern,
        address: result.derivedAddress,
        txHash: result.txHash || null,
        chainId: job.webhookData.chain_id || null,
        elapsed: parseFloat(elapsed),
        status: 'success'
      });
      
      // Forward to downstream if configured
      if (DOWNSTREAM_URL) {
        try {
          await axios.post(DOWNSTREAM_URL, {
            ...job.webhookData,
            ...result
          });
        } catch (e) {
          console.error('Downstream forward failed:', e.message);
        }
      }
      
      // Respond to original webhook caller if callback stored
      if (job.callback) {
        job.callback({ success: true, ...result, elapsedSeconds: parseFloat(elapsed) });
      }
    } else {
      stats.errorCount++;
      stats.recentRequests.unshift({
        timestamp: new Date().toISOString(),
        jobId,
        workerId,
        error: error || 'Unknown error',
        elapsed: parseFloat(elapsed),
        status: 'error'
      });
      
      if (job.callback) {
        job.callback({ success: false, error, elapsedSeconds: parseFloat(elapsed) });
      }
    }
    
    if (stats.recentRequests.length > 100) stats.recentRequests.pop();
    completedJobs.unshift({ jobId, success, elapsed });
    if (completedJobs.length > 100) completedJobs.pop();
  }
  
  res.json({ success: true });
  dispatchJobs();
});

// Main webhook endpoint
app.post('/webhook', (req, res) => {
  stats.totalRequests++;
  
  const rValue = req.body.R || req.body.r;
  if (!rValue) {
    stats.errorCount++;
    return res.status(400).json({ error: 'Missing required field: R or r' });
  }
  
  const pattern = extractPattern(rValue);
  const jobId = crypto.randomUUID();
  
  console.log(`Received webhook - Job ${jobId}, Pattern: ${pattern}`);
  
  // Check if any workers available
  const availableWorkers = Array.from(workers.values()).filter(w => w.status === 'idle').length;
  const queuePosition = jobQueue.length;
  
  // Queue the job
  const job = {
    jobId,
    pattern,
    webhookData: req.body,
    startTime: Date.now()
  };
  
  // For async processing, respond immediately
  jobQueue.push(job);
  dispatchJobs();
  
  res.json({
    success: true,
    jobId,
    pattern,
    queuePosition,
    availableWorkers,
    message: 'Job queued for processing'
  });
});

// Synchronous webhook (waits for result)
app.post('/webhook/sync', async (req, res) => {
  stats.totalRequests++;
  
  const rValue = req.body.R || req.body.r;
  if (!rValue) {
    stats.errorCount++;
    return res.status(400).json({ error: 'Missing required field: R or r' });
  }
  
  const pattern = extractPattern(rValue);
  const jobId = crypto.randomUUID();
  
  console.log(`Received sync webhook - Job ${jobId}, Pattern: ${pattern}`);
  
  // Create promise that resolves when job completes
  const resultPromise = new Promise((resolve) => {
    const job = {
      jobId,
      pattern,
      webhookData: req.body,
      startTime: Date.now(),
      callback: resolve
    };
    jobQueue.push(job);
    dispatchJobs();
  });
  
  // Set timeout
  const timeout = parseInt(req.query.timeout) || 600;
  const timeoutPromise = new Promise((resolve) => {
    setTimeout(() => resolve({ success: false, error: 'Request timeout' }), timeout * 1000);
  });
  
  const result = await Promise.race([resultPromise, timeoutPromise]);
  
  if (result.success) {
    res.json(result);
  } else {
    res.status(500).json(result);
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Stats API
app.get('/api/stats', (req, res) => {
  const workerList = Array.from(workers.entries()).map(([id, w]) => ({
    id,
    status: w.status,
    currentJob: w.currentJob,
    lastSeen: new Date(w.lastSeen).toISOString()
  }));
  
  res.json({
    workers: workerList,
    workerCount: workers.size,
    activeWorkers: workerList.filter(w => w.status === 'busy').length,
    idleWorkers: workerList.filter(w => w.status === 'idle').length,
    queueLength: jobQueue.length,
    activeJobs: activeJobs.size,
    ...stats,
    uptime: process.uptime()
  });
});

// Unified monitoring panel
app.get('/monitor', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Vanity Cluster Monitor</title>
  <meta charset="utf-8">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0d1117; color: #c9d1d9; padding: 20px; }
    h1 { color: #58a6ff; margin-bottom: 20px; }
    h2 { color: #c9d1d9; margin: 25px 0 15px 0; font-size: 18px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 20px; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; }
    .card h3 { color: #8b949e; font-size: 11px; text-transform: uppercase; margin-bottom: 6px; }
    .card .value { font-size: 28px; font-weight: bold; color: #58a6ff; }
    .card .value.success { color: #3fb950; }
    .card .value.error { color: #f85149; }
    .card .value.active { color: #d29922; }
    .card .value.idle { color: #8b949e; }
    .workers { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; margin-bottom: 20px; }
    .worker { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 12px; }
    .worker .name { font-weight: 600; font-size: 14px; margin-bottom: 4px; }
    .worker .status { font-size: 12px; padding: 2px 8px; border-radius: 12px; display: inline-block; }
    .worker .status.busy { background: #d29922; color: #000; }
    .worker .status.idle { background: #238636; color: #fff; }
    .worker .job { font-size: 11px; color: #8b949e; margin-top: 6px; font-family: monospace; }
    table { width: 100%; border-collapse: collapse; background: #161b22; border-radius: 8px; overflow: hidden; }
    th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid #30363d; font-size: 13px; }
    th { background: #21262d; color: #8b949e; font-size: 11px; text-transform: uppercase; }
    .status-success { color: #3fb950; }
    .status-error { color: #f85149; }
    .mono { font-family: 'SF Mono', Consolas, monospace; font-size: 12px; }
    .refresh { color: #8b949e; font-size: 11px; margin-top: 15px; }
    a { color: #58a6ff; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <h1>⚡ Vanity Cluster Monitor</h1>
  
  <div class="grid">
    <div class="card"><h3>Workers</h3><div class="value" id="workers">-</div></div>
    <div class="card"><h3>Active</h3><div class="value active" id="active">-</div></div>
    <div class="card"><h3>Idle</h3><div class="value idle" id="idle">-</div></div>
    <div class="card"><h3>Queue</h3><div class="value" id="queue">-</div></div>
    <div class="card"><h3>Total Jobs</h3><div class="value" id="total">-</div></div>
    <div class="card"><h3>Success</h3><div class="value success" id="success">-</div></div>
    <div class="card"><h3>Errors</h3><div class="value error" id="errors">-</div></div>
    <div class="card"><h3>Success Rate</h3><div class="value" id="rate">-</div></div>
  </div>
  
  <h2>Workers</h2>
  <div class="workers" id="workerList"></div>
  
  <h2>Recent Jobs</h2>
  <table>
    <thead><tr><th>Time</th><th>Worker</th><th>Status</th><th>Pattern</th><th>Address</th><th>Tx Hash</th><th>Duration</th></tr></thead>
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
        1: 'https://etherscan.io/tx/', 5: 'https://goerli.etherscan.io/tx/',
        11155111: 'https://sepolia.etherscan.io/tx/', 56: 'https://bscscan.com/tx/',
        137: 'https://polygonscan.com/tx/', 42161: 'https://arbiscan.io/tx/',
        10: 'https://optimistic.etherscan.io/tx/', 8453: 'https://basescan.org/tx/',
        43114: 'https://snowtrace.io/tx/'
      };
      return explorers[chainId] || 'https://etherscan.io/tx/';
    }
    function formatTxHash(r) {
      if (!r.txHash) return '-';
      const short = r.txHash.substring(0, 10) + '...';
      const url = getExplorerUrl(r.chainId, r.txHash);
      return '<a href="' + url + r.txHash + '" target="_blank">' + short + '</a>';
    }
    async function refresh() {
      try {
        const res = await fetch('/api/stats');
        const d = await res.json();
        document.getElementById('workers').textContent = d.workerCount;
        document.getElementById('active').textContent = d.activeWorkers;
        document.getElementById('idle').textContent = d.idleWorkers;
        document.getElementById('queue').textContent = d.queueLength;
        document.getElementById('total').textContent = d.totalRequests;
        document.getElementById('success').textContent = d.successCount;
        document.getElementById('errors').textContent = d.errorCount;
        document.getElementById('rate').textContent = d.totalRequests ? ((d.successCount/d.totalRequests)*100).toFixed(1)+'%' : '-';
        
        document.getElementById('workerList').innerHTML = d.workers.map(w => 
          '<div class="worker">' +
          '<div class="name">' + w.id.substring(0, 12) + '</div>' +
          '<span class="status ' + w.status + '">' + w.status.toUpperCase() + '</span>' +
          (w.currentJob ? '<div class="job">Job: ' + w.currentJob.substring(0, 8) + '...</div>' : '') +
          '</div>'
        ).join('') || '<div style="color:#8b949e">No workers connected</div>';
        
        document.getElementById('requests').innerHTML = d.recentRequests.slice(0,25).map(r => 
          '<tr><td class="mono">' + new Date(r.timestamp).toLocaleTimeString() + '</td>' +
          '<td class="mono">' + (r.workerId ? r.workerId.substring(0,8) : '-') + '</td>' +
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

app.listen(PORT, () => {
  console.log(`Coordinator running on port ${PORT}`);
  console.log(`Webhook endpoint: http://localhost:${PORT}/webhook`);
  console.log(`Sync webhook: http://localhost:${PORT}/webhook/sync`);
  console.log(`Monitor panel: http://localhost:${PORT}/monitor`);
});

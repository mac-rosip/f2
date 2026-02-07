# Agent Handoff: MassedCompute GPU Pricing Comparison

## Task
Log into vm.massedcompute.com, find all available GPU instance types and their hourly pricing, and produce a cost analysis for running profanity2 (an OpenCL Ethereum vanity address generator).

## Login Credentials
- URL: https://vm.massedcompute.com
- Email: jazzcapn07@gmail.com
- Password: Lolwtf123!

## What To Extract
From the site, get every available GPU option and its **per-hour price**. Apply a **50% discount** to all listed prices (user has a coupon).

## Profanity2 Hash Rate Reference
These are known/estimated solo MH/s values for profanity2 (OpenCL, integer/elliptic-curve, NOT tensor):

| GPU | Solo MH/s |
|-----|-----------|
| RTX 3070 | 450 |
| RTX 3080 | 550 |
| RTX 3090 | 650 |
| RTX A5000 | 550 |
| RTX A6000 | 696 |
| RTX 4090 | 1,100 |
| A40 | 500 |
| L40S | 700 |
| A100 | 1,500 |
| H100 | 2,500 |

For any GPU not listed above, extrapolate based on OpenCL integer compute performance relative to the known cards. Do NOT assume tensor core or FP16 scaling — this workload is pure integer/EC math.

## Operating Parameters
- 5 concurrent profanity2 processes per GPU
- Per-process MH/s = Solo MH/s / 5
- Current pattern: 8 hex chars (first 4 + last 4 = 32 bits)
- Also calculate for 7 hex chars (first 4 + last 3 = 28 bits)

## Formulas
- **Avg seconds per job** = 2^32 / (per_process_MH/s * 1,000,000) for 8-char; divide by 16 for 7-char
- **Jobs per hour per GPU** = (3600 / seconds_per_job) * 5
- **GPUs needed** = ceil(6,600 / jobs_per_hour_per_gpu)
- **Monthly cost** = num_GPUs * hourly_price_after_discount * 24 * 30.44

## Demand
Measured inbound job rate: **~6,600 jobs/hour** (~110 jobs/min, sustained 24/7).

## Output Format
Produce TWO tables (one for 8-char, one for 7-char matching), each with columns:

| GPU | Listed $/hr | 50% Off $/hr | Per-proc MH/s | Avg time/job | Jobs/hr/GPU | GPUs needed | Monthly cost |

Sort by monthly cost ascending (cheapest first).

## Comparison Context
Include these external provider prices (already researched) for comparison at the bottom:

| GPU | Provider | $/hr |
|-----|----------|------|
| RTX 3070 | Vast.ai | $0.068 |
| RTX 3080 | RunPod | $0.09 |
| RTX 3090 | RunPod | $0.11 |
| RTX 4090 | RunPod | $0.20 |
| A6000 | RunPod | $0.25 |
| A100 80GB | Vast.ai | $0.67 |
| H100 | RunPod | $1.50 |

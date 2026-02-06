# AGENTS.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Overview

profanity2 is a GPU-accelerated Ethereum vanity address generator using OpenCL. Unlike the original profanity (which had a critical randomness vulnerability), this fork takes a user-provided public key and advances it by a random offset to find vanity addresses. The resulting private key offset must be added to the original seed private key to derive the final vanity address key.

## Build Commands

```bash
# Build (outputs profanity2.x64)
make

# Clean build artifacts
make clean
```

Requires OpenCL development libraries:
- Linux: `libOpenCL` (install `ocl-icd-opencl-dev` or vendor SDK)
- macOS: Uses system OpenCL framework

## Running

The `-z` flag is mandatory and takes a 128-character hex public key (without "04" prefix):

```bash
./profanity2.x64 --leading 0 -z <128_CHAR_PUBLIC_KEY>
./profanity2.x64 --matching dead -z <128_CHAR_PUBLIC_KEY>
./profanity2.x64 --benchmark -z <128_CHAR_PUBLIC_KEY>
```

## Architecture

### Host Code (C++)

- `profanity.cpp` - Entry point: parses arguments, discovers OpenCL devices, creates context, compiles kernels, and starts the Dispatcher
- `Dispatcher.cpp/.hpp` - Core orchestrator that manages GPU devices, enqueues kernels, handles async results via callbacks, and tracks speed/progress. Each Device struct holds its own OpenCL queue, kernels, and memory buffers
- `Mode.cpp/.hpp` - Defines scoring strategies (matching, leading, zeros, letters, etc.) and maps them to the corresponding OpenCL scoring kernel
- `ArgParser.hpp` - Template-based command-line parser supporting typed switches and multi-value arguments
- `types.hpp` - Shared struct definitions (`mp_number`, `point`, `result`) with identical layout to OpenCL kernels

### OpenCL Kernels

- `profanity.cl` - Multi-precision arithmetic for secp256k1 elliptic curve operations. Key kernels:
  - `profanity_init` - Initialize points from seed
  - `profanity_inverse` - Batch modular inverses (Montgomery's trick)
  - `profanity_iterate` - Point addition iteration
  - `profanity_score_*` - Various scoring functions for vanity patterns
  - `profanity_transform_contract` - Compute contract address from account
- `keccak.cl` - Keccak-256 hash implementation for deriving Ethereum addresses from public keys

### Data Flow

1. User provides a seed public key via `-z`
2. Dispatcher creates a random 256-bit offset per device
3. GPU kernels advance the public key by scalar multiplication of the base point
4. Keccak hash converts resulting public keys to Ethereum addresses
5. Scoring kernels evaluate address patterns and report high-score results
6. Output shows the private key offset (add to original seed key for final private key)

### Build Configuration

The Makefile auto-detects macOS vs Linux:
- macOS: Links `-framework OpenCL`
- Linux: Links `-lOpenCL` with `-mcmodel=large` for the precomputed data

Kernel build options are set at runtime: `-D PROFANITY_INVERSE_SIZE=<n> -D PROFANITY_MAX_SCORE=40`

### Caching

Compiled OpenCL binaries are cached to `cache-opencl.<inverseSize>.<deviceId>` files. Use `--no-cache` to force recompilation.

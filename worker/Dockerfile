# Multi-stage build: compile profanity2, then run with Node.js
# NOTE: Build context should be project root (set in docker-compose.yml)
FROM ubuntu:22.04 AS builder

RUN apt-get update && apt-get install -y \
    build-essential \
    ocl-icd-opencl-dev \
    libsqlite3-dev \
    libcurl4-openssl-dev \
    libsecp256k1-dev \
    libwebsockets-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY profanity2/ .

RUN make clean && make

# Runtime stage
FROM ubuntu:22.04

# Install runtime dependencies
RUN apt-get update && apt-get install -y \
    ocl-icd-libopencl1 \
    libsqlite3-0 \
    libcurl4 \
    libsecp256k1-0 \
    libwebsockets16 \
    curl \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy profanity2 binary and OpenCL kernels
COPY --from=builder /build/profanity2.x64 /app/profanity2/
COPY --from=builder /build/profanity.cl /app/profanity2/
COPY --from=builder /build/keccak.cl /app/profanity2/

# Copy and install Node.js app
COPY worker/package*.json /app/
RUN npm ci --omit=dev
COPY worker/server.js /app/

ENV PORT=3001
ENV PROFANITY_PATH=/app/profanity2/profanity2.x64
ENV TIMEOUT_SECONDS=300

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:${PORT}/health || exit 1

CMD ["node", "server.js"]

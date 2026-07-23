# =============================================================================
# BalanceFrame — multi-stage production Docker image
# =============================================================================
# Build stage: compile Rust N-API addon + build TypeScript workspace
# -----------------------------------------------------------------------------
FROM node:24-bookworm AS builder

# Install Rust toolchain (matching crates/node-binding targets)
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH
RUN set -eux; \
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path \
      --default-toolchain stable --profile minimal; \
    rustup target add x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu; \
    cargo --version; \
    rustc --version

# Install pnpm
ENV PNPM_HOME=/usr/local/pnpm \
    PATH=/usr/local/pnpm:/usr/local/pnpm/bin:$PATH
RUN npm install -g pnpm@10

# Install native build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    pkg-config \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency manifests first (layer caching)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY apps/cli/package.json apps/cli/package.json
COPY apps/server/package.json apps/server/package.json
COPY packages/actual-adapter/package.json packages/actual-adapter/package.json
COPY packages/application/package.json packages/application/package.json
COPY packages/inference/package.json packages/inference/package.json
COPY packages/protocol-generated/package.json packages/protocol-generated/package.json
COPY packages/workflow-store/package.json packages/workflow-store/package.json
COPY crates/node-binding/package.json crates/node-binding/package.json

# Install dependencies (frozen lockfile ensures reproducible builds)
RUN pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Build Rust N-API addon for the current platform
# (docker buildx --platform selects the matching target)
RUN cd crates/node-binding && pnpm build

# Build all workspace packages (includes Nuxt/Nitro app build)
RUN pnpm build

# -----------------------------------------------------------------------------
# Runtime stage: minimal Node 24 image
# -----------------------------------------------------------------------------
FROM node:24-slim

# Create non-root user
RUN groupadd -r balanceframe && useradd -r -g balanceframe -d /app -s /sbin/nologin balanceframe

WORKDIR /app

# Copy entrypoint guard
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Copy built application from builder
COPY --from=builder /app/apps/web/.output ./web-output
COPY --from=builder /app/node_modules ./node_modules

# Copy the compiled N-API addon with its JS wrapper and type declarations
COPY --from=builder /app/crates/node-binding/balanceframe.node ./node_modules/@balanceframe/native/balanceframe.node
COPY --from=builder /app/crates/node-binding/index.js ./node_modules/@balanceframe/native/index.js 2>/dev/null || true
COPY --from=builder /app/crates/node-binding/index.d.ts ./node_modules/@balanceframe/native/index.d.ts 2>/dev/null || true

# Ensure the N-API addon can be found by require()
RUN mkdir -p /app/node_modules/@balanceframe/native

# Create data directory with writable ownership
RUN mkdir -p /data && chown balanceframe:balanceframe /data

# Set runtime defaults
ENV NUXT_AUTH_DB_PATH=/data/auth.db \
    BALANCEFRAME_WORKFLOW_DB_PATH=/data/workflow.db

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "web-output/server/index.mjs"]

# Metadata
EXPOSE 3000
LABEL org.opencontainers.image.title="BalanceFrame" \
      org.opencontainers.image.description="AI-assisted budget categorization on top of Actual Budget" \
      org.opencontainers.image.source="https://github.com/balanceframe/balanceframe" \
      org.opencontainers.image.licenses="Apache-2.0"

# syntax=docker/dockerfile:1.7
# Glasswing supplies its UI through @synara/react in the Next.js application.
# Use Dockerfile.standalone when serving Synara's own browser UI.
# This image serves the API/WebSocket runtime, not the standalone Synara UI.
ARG NODE_VERSION=24.13.1
ARG BUN_VERSION=1.3.12

FROM node:${NODE_VERSION}-bookworm-slim AS manifests
ARG BUN_VERSION
RUN apt-get update \
  && apt-get install --yes --no-install-recommends build-essential ca-certificates git python3 \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global "bun@${BUN_VERSION}"
WORKDIR /app
COPY package.json bun.lock ./
COPY patches ./patches
COPY apps/server/package.json ./apps/server/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY apps/desktop/package.json ./apps/desktop/package.json
COPY apps/marketing/package.json ./apps/marketing/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/shared/package.json ./packages/shared/package.json
COPY scripts/package.json ./scripts/package.json

FROM manifests AS production-deps
# prepare patches the development TypeScript compiler, which is intentionally
# absent here. Install runtime deps only and explicitly build the native PTY.
RUN bun install --frozen-lockfile --production --filter @synara/cli --ignore-scripts \
  && cd apps/server/node_modules/node-pty \
  && npm run install && npm run postinstall

FROM manifests AS build
RUN bun install --frozen-lockfile --filter @synara/cli
COPY . .
RUN bun run --cwd apps/server build

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
RUN apt-get update \
  && apt-get install --yes --no-install-recommends \
    bash ca-certificates curl git openssh-client procps ripgrep socat tini \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=production-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=production-deps --chown=node:node /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=production-deps /app/package.json ./package.json
COPY --from=production-deps /app/apps/server/package.json ./apps/server/package.json
COPY --from=build --chown=node:node /app/apps/server/dist ./apps/server/dist
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN --mount=type=bind,from=build,source=/app/scripts,target=/app/scripts \
    node apps/server/dist/index.mjs --help >/dev/null \
    && node scripts/node-pty-smoke.mjs
RUN case "$(dpkg --print-architecture)" in \
      amd64) sdk_arch=x64 ;; arm64) sdk_arch=arm64 ;; *) exit 1 ;; esac \
  && sdk_claude="$(find /app/node_modules/.bun -path "*/node_modules/@anthropic-ai/claude-agent-sdk-linux-${sdk_arch}/claude" -type f -print -quit)" \
  && test -n "$sdk_claude" \
  && ln -s "$sdk_claude" /usr/local/bin/claude \
  && mkdir -p /data /home/node/Documents/Synara \
  && chmod +x /app/docker-entrypoint.sh \
  && chown -R node:node /data /home/node/Documents
ENV HOME=/home/node NODE_ENV=production SYNARA_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=1 \
    SYNARA_HOME=/data SYNARA_HOST=127.0.0.1 SYNARA_MODE=web SYNARA_NO_BROWSER=1 SYNARA_PORT=3774
EXPOSE 3773
HEALTHCHECK --interval=5s --timeout=3s --start-period=20s --retries=12 \
  CMD node -e "fetch('http://127.0.0.1:3773/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
CMD ["/app/docker-entrypoint.sh"]

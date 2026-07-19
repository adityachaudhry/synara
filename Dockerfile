# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=24.13.1
ARG BUN_VERSION=1.3.12

FROM node:${NODE_VERSION}-bookworm-slim AS build

ARG BUN_VERSION

RUN apt-get update \
  && apt-get install --yes --no-install-recommends \
    build-essential \
    ca-certificates \
    git \
    python3 \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global "bun@${BUN_VERSION}"

WORKDIR /app
COPY . .

RUN bun install --frozen-lockfile
RUN bun run --cwd apps/web build
RUN bun run --cwd apps/server build

FROM node:${NODE_VERSION}-bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install --yes --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    openssh-client \
    procps \
    ripgrep \
    socat \
    tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build --chown=node:node /app /app

RUN case "$(dpkg --print-architecture)" in \
      amd64) sdk_arch=x64 ;; \
      arm64) sdk_arch=arm64 ;; \
      *) echo "Unsupported SDK architecture" >&2; exit 1 ;; \
    esac \
  && sdk_claude="$(find /app/node_modules/.bun -path "*/node_modules/@anthropic-ai/claude-agent-sdk-linux-${sdk_arch}/claude" -type f -print -quit)" \
  && test -n "$sdk_claude" \
  && ln -s "$sdk_claude" /usr/local/bin/claude \
  && mkdir -p /data /home/node/Documents/Synara \
  && chmod +x /app/docker-entrypoint.sh \
  && chown -R node:node /data /home/node/Documents

ENV HOME=/home/node \
  NODE_ENV=production \
  SYNARA_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=1 \
  SYNARA_HOME=/data \
  SYNARA_HOST=127.0.0.1 \
  SYNARA_MODE=web \
  SYNARA_NO_BROWSER=1 \
  SYNARA_PORT=3774

USER node
WORKDIR /app

EXPOSE 3773

HEALTHCHECK --interval=5s --timeout=3s --start-period=20s --retries=12 \
  CMD node -e "fetch('http://127.0.0.1:3773/health').then((response) => { if (!response.ok) process.exit(1) }).catch(() => process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
CMD ["/app/docker-entrypoint.sh"]

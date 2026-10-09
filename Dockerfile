# syntax=docker/dockerfile:1
# FinTrack image (ADR-032). glibc base: @libsql/client ships native bindings, so no Alpine.
ARG NODE_IMAGE=node:25-bookworm-slim

# Build on the host's own architecture so tsc never runs under QEMU when targeting arm64.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Production dependencies on the target platform: needs that architecture's native libsql prebuild.
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM ${NODE_IMAGE} AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

LABEL org.opencontainers.image.title="FinTrack" \
      org.opencontainers.image.description="AI-first personal finance manager: MCP server, REST API and dashboards over an encrypted libSQL database." \
      org.opencontainers.image.source="https://github.com/RafaelFCarneiro/fintrack" \
      org.opencontainers.image.licenses="Apache-2.0"

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# The repo manifest carries 0.0.0-development (semantic-release stamps it only in its own workspace);
# the release job passes the real version so the server reports it.
ARG VERSION=0.0.0-development
COPY package.json ./
RUN npm pkg set version="${VERSION}"
COPY drizzle ./drizzle
COPY ui ./ui
COPY skills ./skills

# HOST=0.0.0.0 makes FINTRACK_AUTH default to `required` (ADR-033): every route but /api/health, /ui/login and
# /ui/setup needs a session; the first start prints a one-time setup code to the log to claim the owner.
ENV NODE_ENV=production \
    MCP_TRANSPORT=http \
    HOST=0.0.0.0 \
    PORT=51737 \
    DB_PATH=/data/fintrack.db

# /api/health is the one unauthenticated probe (liveness + `db`); /api/status needs a session.
# /data is the only writable path; the encryption key is supplied at run time (FINTRACK_DB_KEY_FILE), never baked in.
RUN mkdir /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 51737

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>r.ok?r.json():Promise.reject()).then(s=>process.exit(s.db==='ok'?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/main.js"]

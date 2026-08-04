# Build stage: install, build web (Vite) + server (esbuild bundle).
# Node 24+ provides node:sqlite built in, so there is no native module to compile.
FROM node:24-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json turbo.json ./
COPY packages/core/package.json packages/core/
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/
RUN npm ci

COPY . .
# Git hash for the About/version string. .git is excluded from the build context
# (see .dockerignore), so the host passes the short hash in as a build arg; Vite
# reads GIT_HASH from the environment. Defaults to 'unknown' if not provided.
ARG GIT_HASH=unknown
ENV GIT_HASH=$GIT_HASH
# Build only what the server image needs (server + web; turbo pulls in @carbon/core).
# This excludes the native shells (@carbon/desktop / @carbon/mobile), which need
# Rust/Android toolchains not present in this image.
RUN npm run build:server

# Runtime stage: just the server bundle + built web assets. Fully self-contained
# (everything is bundled; SQLite is a Node builtin), so no node_modules needed.
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    STATIC_DIR=web \
    DATABASE_PATH=/app/data/carbon.db \
    PORT=3069

COPY --from=build /app/apps/server/dist ./server
COPY --from=build /app/apps/web/dist ./web

# Run unprivileged. The bundle and web assets stay root-owned (0755) so the app
# user can read but not rewrite its own code; /app/data is the only writable path
# and it is pre-created as node:node so a named/anonymous volume inherits that
# ownership. A bind mount keeps the host's ownership instead — the host directory
# must be owned by uid 1000 (see README "Self-host").
RUN install -d -o node -g node /app/data
USER node

EXPOSE 3069
VOLUME ["/app/data"]
CMD ["node", "server/index.js"]

# syntax=docker/dockerfile:1
# orbitd and the App in one container (ADR-017), API-key mode only: the
# Claude Code CLI and its subscription login never enter this image.
#
#   docker compose up -d                       # see compose.yaml
#   docker build -f docker/orbitd.Dockerfile -t orbit .
#
# `build` makes the npm tarball from this checkout exactly as the release
# does, `install` installs it with npm, and the last stage is the slim
# runtime. better-sqlite3 compiles from source when no prebuilt binary
# matches the platform, so the first two stages have a toolchain; the
# runtime image does not.

ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS toolchain
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

FROM toolchain AS build
WORKDIR /usr/src/orbit
RUN corepack enable
# Fetch dependencies from the lockfile alone, so source edits reuse the layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm fetch --frozen-lockfile
COPY packages packages
COPY apps apps
COPY plugins plugins
COPY packaging packaging
COPY tools tools
COPY tsconfig.base.json tsconfig.json LICENSE ./
RUN pnpm install --offline --frozen-lockfile
RUN pnpm --filter orbit-bots build \
  && mkdir -p /out \
  && cd packaging/npm \
  && npm pack --pack-destination /out \
  && mv /out/orbit-bots-*.tgz /out/orbit-bots.tgz

# `npm install -g` the tarball into /opt/orbit (copied into the runtime).
FROM toolchain AS install
COPY --from=build /out/orbit-bots.tgz /tmp/orbit-bots.tgz
RUN npm install --global --prefix /opt/orbit --no-audit --no-fund /tmp/orbit-bots.tgz \
  && npm cache clean --force

FROM ${NODE_IMAGE}
# git: worktree Bots and the GitHub plugin; tini: PID 1 that forwards signals.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git tini \
  && rm -rf /var/lib/apt/lists/*
COPY --from=install /opt/orbit /opt/orbit
RUN groupadd --gid 10001 orbit \
  && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin orbit \
  && mkdir -p /data \
  && chown orbit:orbit /data \
  && chmod 0700 /data
# ORBIT_HOST=0.0.0.0 and ORBIT_CONTAINER=1 come from compose.yaml: without
# them orbitd listens on the container's own loopback only.
ENV PATH=/opt/orbit/bin:$PATH \
  ORBIT_HOME=/data \
  ORBIT_PORT=7420
# Orbit's data (database, vault, workspaces, memory) and the engine's own
# state in $HOME (session transcripts a parked Run resumes from).
VOLUME ["/data", "/home/orbit"]
USER orbit
WORKDIR /data
EXPOSE 7420
# /v1/health is the one unauthenticated route; the Host header is loopback.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.ORBIT_PORT||7420)+'/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["orbitd"]

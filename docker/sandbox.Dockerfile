# Orbit Bot sandbox image (ADR-004, ADR-018): the Claude Code engine plus basic
# tools. API-key mode only — subscription credentials never enter this image or
# its containers, and neither does the API key: containers run without a
# network, and the engine reaches the Anthropic API (and, with an allowlist,
# the egress proxy) only through orbitd's Unix sockets, which socat bridges to
# loopback ports inside the container.
#
# Build:
#   docker build -f docker/sandbox.Dockerfile -t orbit-sandbox:latest .
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ripgrep ca-certificates socat \
  && rm -rf /var/lib/apt/lists/*

RUN npm i -g @anthropic-ai/claude-code@2.1.289 \
  && npm cache clean --force

RUN groupadd --gid 10001 orbit \
  && useradd --uid 10001 --gid 10001 --create-home --shell /bin/bash orbit \
  && mkdir -p /workspace \
  && chown orbit:orbit /workspace

WORKDIR /workspace
USER orbit

CMD ["sleep", "infinity"]

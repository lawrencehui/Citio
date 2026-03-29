FROM node:22-slim

# Create non-root user
RUN useradd -m -s /bin/bash citio

# Install coding agent CLIs globally
RUN npm install -g @openai/codex @anthropic-ai/claude-code

# Install base tools (git, gh, aws-cli, jq, curl)
RUN apt-get update && apt-get install -y \
    git curl jq unzip openssh-client procps \
    && curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscli.zip" \
    && unzip awscli.zip && ./aws/install && rm -rf aws awscli.zip \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Copy application
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY dist/ ./dist/

# Config volume — mount your citio.yaml here, edit anytime, restart to apply
RUN mkdir -p /config /workspace /memory /tmp/citio \
    && chown -R citio:citio /config /workspace /memory /tmp/citio /app
VOLUME ["/config", "/workspace", "/memory"]

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:3001/healthz || exit 1

# Run as non-root
USER citio

# Default env vars (override at runtime)
ENV CITIO_CONFIG=/config/citio.yaml
ENV CITIO_WORKSPACE=/workspace
ENV CITIO_MEMORY=/memory
ENV NODE_ENV=production

EXPOSE 3001

ENTRYPOINT ["node", "dist/index.js"]

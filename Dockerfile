# OCD (Omni Coder Dashboard) v5.3.0 — Docker image
# Runs the dashboard server with built client and local ONNX embeddings.
# Your AI tool data is mounted from the host (read-only).
#
# Quick start:
#   docker compose up
#
# Or manually:
#   docker build -t ai-dashboard .
#   docker run -p 3030:3030 \
#     -v ~/.claude:/root/.claude:ro \
#     -v ~/.cursor:/root/.cursor:ro \
#     -v ~/.gemini:/root/.gemini:ro \
#     -v $(pwd)/data:/app/data \
#     ai-dashboard

FROM node:20-alpine

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy workspace config and package files first (cache layer)
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/server/package.json ./apps/server/
COPY apps/client/package.json ./apps/client/

# Install all dependencies (including devDependencies for build)
RUN pnpm install --frozen-lockfile

# Copy source
COPY apps/ ./apps/
COPY bin/ ./bin/
COPY .env.example ./

# Build client (Vite) and server (TypeScript)
RUN pnpm --filter @ocd/client run build
RUN pnpm --filter @ocd/server run build

# Remove devDependencies after build
RUN pnpm prune --prod

# Data directory for SQLite DB
RUN mkdir -p /app/data

# Non-root user
RUN addgroup -S dashboard && adduser -S dashboard -G dashboard
RUN chown -R dashboard:dashboard /app
USER dashboard

EXPOSE 3030

ENV PORT=3030
ENV DB_PATH=/app/data/analytics.db
ENV NODE_ENV=production

CMD ["node", "apps/server/dist/index.js"]

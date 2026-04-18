# OCD (Omni Coder Dashboard) — Docker image
# Runs the dashboard server with built client and local ONNX embeddings.
# Your AI tool data is mounted from the host (read-only).
#
# Quick start:
#   docker compose up
#
# Or manually:
#   docker build -t ocd-dashboard .
#   docker run -p 3030:3030 \
#     -v ~/.claude:/home/dashboard/.claude:ro \
#     -v ~/.cursor:/home/dashboard/.cursor:ro \
#     -v ~/.gemini:/home/dashboard/.gemini:ro \
#     -v $(pwd)/data:/app/data \
#     ocd-dashboard

FROM node:20-alpine

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy everything needed for install + build (source must be present
# before `pnpm install` because the root package.json has a `prepare`
# lifecycle script that runs `pnpm run build`).
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/ ./apps/
COPY bin/ ./bin/
COPY .env.example ./

# Install all dependencies — the prepare script builds client + server
RUN pnpm install --frozen-lockfile

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

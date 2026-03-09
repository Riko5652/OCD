# AI Productivity Dashboard v3.0 — Docker image
# Runs the dashboard server; your AI tool data is mounted from the host.
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

WORKDIR /app

# Install dependencies first (cache layer)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy source
COPY src/ ./src/
COPY public/ ./public/
COPY bin/ ./bin/
COPY .env.example ./

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

CMD ["node", "src/server.js"]

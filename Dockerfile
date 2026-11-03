# Stage 1: Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Native build toolchain for better-sqlite3 (node-gyp source-build fallback when no
# prebuilt binary matches the current node ABI).
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# Stage 2: Production runner
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4000
ENV DB_PATH=/app/data/mpgl_app.db

# Install curl (prod healthcheck) and wget (staging healthcheck) for health probes,
# plus the native build toolchain for better-sqlite3's node-gyp fallback.
RUN apk add --no-cache curl wget python3 make g++


COPY package*.json ./
RUN npm ci --only=production

COPY --from=builder /app/dist ./dist
COPY public ./public

RUN mkdir -p /app/data && chown -R node:node /app

USER node

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:4000/healthz || exit 1

CMD ["node", "dist/index.js"]

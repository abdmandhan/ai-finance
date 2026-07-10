# ============================================
# Tigeri AI (LangGraph) Dockerfile — standalone Node 24 + pnpm project
# Build from graph/: docker build -t tigeri-graph .
# ============================================

# ---------- Stage 1: dependencies ----------
FROM node:24-alpine AS deps
RUN corepack enable && corepack prepare pnpm@10 --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile

# ---------- Stage 2: build ----------
FROM node:24-alpine AS builder
RUN corepack enable && corepack prepare pnpm@10 --activate
WORKDIR /app

COPY --from=deps /app/node_modules node_modules
COPY . .
RUN pnpm build

# ---------- Stage 3: runner ----------
FROM node:24-alpine AS runner
RUN corepack enable && corepack prepare pnpm@10 --activate
WORKDIR /app

ENV NODE_ENV=production

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --prod --frozen-lockfile

# Built output (tsup resolved @/ aliases during build)
COPY --from=builder /app/dist ./dist

# Runtime config
COPY config.toml ./

CMD ["node", "dist/index.js"]

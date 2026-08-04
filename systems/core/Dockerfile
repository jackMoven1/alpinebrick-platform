# syntax=docker/dockerfile:1

# Build context is systems/core (render.yaml sets rootDir: systems/core).
# systems/core is deliberately NOT an npm workspace member — it has its own
# lockfile and is self-contained, which is what makes this single-context
# build possible.

FROM node:20-slim AS base
# Prisma's query engine needs OpenSSL, which node:*-slim does not ship.
# Without this the container builds fine and then fails at runtime with
# "Unable to require libquery_engine" — a slow one to diagnose.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app


FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci
# Generate before compiling: the Prisma client's types are imported by src.
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build


FROM base AS runtime
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# prisma/ is needed at runtime, not just at build time: Render's
# preDeployCommand runs `npx prisma migrate deploy` inside this image, which
# needs both schema.prisma and the migrations directory. That is also why the
# prisma CLI is a production dependency rather than a dev one.
COPY prisma ./prisma
RUN npx prisma generate

COPY --from=build /app/dist ./dist

RUN chown -R node:node /app
USER node

# Informational only. Render injects PORT and routes to it; src/server.ts
# reads process.env.PORT and falls back to 4000.
EXPOSE 4000

CMD ["node", "dist/server.js"]

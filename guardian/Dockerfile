# Guardian bot — always-on invariant monitor.
# Multi-stage: build with dev deps (tsup/typescript), run with prod deps only.

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Liveness/metrics port (HEALTH_PORT). Fly reaches it via the internal network.
EXPOSE 9090
CMD ["node", "dist/bot.js"]

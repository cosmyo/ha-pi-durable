# Multi-platform official Node index, resolved 2026-10-03 (amd64 + arm64/v8).
FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
ARG BUILD_VERSION=0.1.0
ARG BUILD_ARCH
LABEL io.hass.name="Hearth Pi" io.hass.description="Experimental durable Home Assistant agent" io.hass.version="${BUILD_VERSION}" io.hass.type="app" io.hass.arch="${BUILD_ARCH}" org.opencontainers.image.licenses="MIT"
WORKDIR /app
ENV NODE_ENV=production HEARTH_MODE=ingress
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY public ./public
# Narrow bootstrap reads root-owned Supervisor options and reowns known DB files.
# main.js permanently drops to UID/GID 1000 before harness/network/model work.
USER 0:0
CMD ["node", "dist/main.js"]

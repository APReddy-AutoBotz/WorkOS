FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS base

FROM base AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html tsconfig.json ./
COPY scripts/build-frontend.mjs scripts/frontend-environment.mjs scripts/frontend-styles.mjs ./scripts/
COPY src ./src
COPY shared ./shared
COPY public ./public

ARG VITE_APP_MODE=production
ARG VITE_ALLOW_TEST_FALLBACK=false
ENV VITE_APP_MODE=${VITE_APP_MODE}
ENV VITE_ALLOW_TEST_FALLBACK=${VITE_ALLOW_TEST_FALLBACK}
RUN npm run build

FROM base AS runtime

ARG APP_VERSION=0.0.0
ENV NODE_ENV=production \
    APP_MODE=production \
    PORT=4000 \
    APP_VERSION=${APP_VERSION}
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY server ./server
COPY shared ./shared
COPY --from=build /app/dist ./dist

ARG BUILD_SHA=unknown
LABEL org.opencontainers.image.revision="${BUILD_SHA}" \
      org.opencontainers.image.version="${APP_VERSION}"
ENV BUILD_SHA=${BUILD_SHA}
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/api/health/ready').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "server/start-production.mjs"]

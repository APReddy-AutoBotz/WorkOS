FROM node:22-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html tsconfig.json ./
COPY scripts/build-frontend.mjs ./scripts/build-frontend.mjs
COPY src ./src
COPY shared ./shared
COPY public ./public

ARG VITE_APP_MODE=production
ARG VITE_ALLOW_TEST_FALLBACK=false
ENV VITE_APP_MODE=${VITE_APP_MODE}
ENV VITE_ALLOW_TEST_FALLBACK=${VITE_ALLOW_TEST_FALLBACK}
RUN npm run build

FROM node:22-alpine AS runtime

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
ENV BUILD_SHA=${BUILD_SHA}
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/api/health/ready').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "server/start-production.mjs"]

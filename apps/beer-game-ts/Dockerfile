# 本番用イメージ。コンパイル済みの JavaScript を、非 root で実行する（tsx は使わない）
FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:26-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:26-alpine
ENV NODE_ENV=production
WORKDIR /app
# RDS への接続（sslmode=require）で、サーバー証明書を検証するための CA バンドル。検証は無効にしない
ADD https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/certs/rds-global-bundle.pem
RUN chmod 755 /app/certs && chmod 444 /app/certs/rds-global-bundle.pem
ENV NODE_EXTRA_CA_CERTS=/app/certs/rds-global-bundle.pem
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY migrations ./migrations
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1
CMD ["node", "dist/main.js"]

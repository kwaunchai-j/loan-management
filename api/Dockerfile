# API image (T-1001). Build context: the api/ folder.
#   runtime  the server (default target): production dependencies, compiled code, runs as a non-root user
#   build    everything, including the prisma CLI and tsx: used (as the "tools" service) for
#            `prisma migrate deploy` and the one-off admin scripts. Never run as the long-lived service.
# No secret is ever copied into an image: configuration comes from env files at run time.
FROM node:22-bookworm-slim AS base
WORKDIR /app
# Prisma's engine needs OpenSSL; CA certificates are needed to call LINE and the push services.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM build AS prune
RUN npm prune --omit=dev

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=prune /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# slips and staged import files live in /data (a volume), outside the code
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 4000
CMD ["node", "dist/index.js"]

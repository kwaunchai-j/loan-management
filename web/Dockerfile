# Web image (T-1001). Build context: the web/ folder. A self-contained Next.js server (standalone output).
# The browser reaches the API through the reverse proxy (/api/* goes straight to the API), so no API
# address is baked in for the browser; API_URL below only matters if a request for /api ever reaches
# this server, and it then points at the API inside the Docker network.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG API_URL=http://api:4000
ENV API_URL=$API_URL BUILD_STANDALONE=1 NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
USER node
EXPOSE 3000
CMD ["node", "server.js"]

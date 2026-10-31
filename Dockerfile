# Multi-stage build: the frontend is compiled here, at image-build time —
# `npm start` builds it at container boot instead, which is too slow/heavy
# for a small free-tier instance (see README.md).
FROM node:20-alpine AS build
WORKDIR /app

COPY web/package*.json web/
RUN npm ci --prefix web

COPY web ./web
RUN npm run build --prefix web

# ---------------------------------------------------------------------------
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0

COPY package*.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY --from=build /app/web/dist ./web/dist

EXPOSE 5174
CMD ["node", "server/index.js"]

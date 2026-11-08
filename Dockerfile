# syntax=docker/dockerfile:1

# ---- build: install all deps, compile the server, bundle the web UI ----
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --workspaces --include-workspace-root
COPY server/ server/
COPY web/ web/
RUN npm run build -w server && npm run build -w web

# ---- runtime: server production deps + compiled server + static web UI ----
FROM node:24-alpine
ENV NODE_ENV=production \
    SOFARR_DATA_DIR=/data
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci -w server --omit=dev && npm cache clean --force
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 5656
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.SOFARR_PORT||5656)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
WORKDIR /app/server
CMD ["node", "dist/index.js"]

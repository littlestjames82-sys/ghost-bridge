# Ghost Bridge Relay — local/Docker image.
# The store is in-memory by default; compose sets GHOST_BRIDGE_STORE_FILE
# so the included volume keeps your queue across restarts.
FROM node:20-alpine
WORKDIR /app
COPY relay/package.json relay/package-lock.json ./relay/
RUN cd relay && npm install --omit=dev --no-audit --no-fund
COPY relay/ ./relay/
ENV HOST=0.0.0.0
EXPOSE 8877
CMD ["node", "relay/local-server.mjs", "8877"]

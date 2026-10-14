# Container image for hosts that run Docker (Railway, Fly.io, a school server...).
#
#   docker build -t equipment-checkout .
#   docker run -d -p 3000:3000 -v equipment-data:/data -e ADMIN_PASSWORD=change-me equipment-checkout
#
# Everything the app stores (database, photos, signatures) lives in /data —
# mount a volume there or it is lost when the container is replaced.
FROM node:22-slim

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY public ./public
COPY docker-entrypoint.sh /usr/local/bin/inventory-entrypoint
RUN chmod +x /usr/local/bin/inventory-entrypoint && mkdir -p /data && chown node:node /data

VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

ENTRYPOINT ["inventory-entrypoint"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]

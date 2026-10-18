FROM node:24-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json server.js ./
COPY lib ./lib
COPY scripts ./scripts
COPY public ./public

# The image carries no database and no master key. Both are created on first start
# inside the volume mounted at /data — lose that volume and every stored sk- key
# becomes undecryptable, so mount a persistent one.
RUN mkdir -p /data && chown -R node:node /data
USER node

ENV HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/data \
    TRUST_PROXY=1

EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]

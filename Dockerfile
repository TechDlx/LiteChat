# Debian rather than Alpine: sharp's glibc prebuilds are its best-supported
# target, and the musl ARM64 combination is the least tested one.
FROM node:20-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
# npm ci needs the platform's optional sharp binary in the lockfile. If the
# lockfile was generated elsewhere (see README), fall back to a resolving install.
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

# DATA_DIR unset => memory only, uploads disabled. Set it (and mount a volume)
# to keep rooms and images across restarts.
ENV PORT=3000
EXPOSE 3000

RUN mkdir -p /data/uploads && chown -R node:node /data /app
USER node

CMD ["node", "server.js"]

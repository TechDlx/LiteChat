FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

# DATA_DIR unset => memory only. Set it (and mount a volume) to keep rooms
# across restarts.
ENV PORT=3000
EXPOSE 3000

RUN mkdir -p /data && chown -R node:node /data /app
USER node

CMD ["node", "server.js"]

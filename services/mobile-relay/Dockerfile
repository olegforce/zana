FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY protocol.mjs server.mjs start.mjs ./
USER node
CMD ["node", "start.mjs"]

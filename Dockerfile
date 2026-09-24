FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && npm ci \
    && apt-get purge -y --auto-remove python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY tsconfig.json ./
COPY src ./src

RUN npm run build


ENV NODE_ENV=production
ENV PADEL_DATABASE_PATH=/app/data/padel.sqlite

RUN mkdir -p /app/data && chown -R node:node /app
USER node

CMD ["npm", "run", "bot"]

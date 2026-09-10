FROM node:22-bookworm-slim

WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev
COPY prisma ./prisma
RUN npx prisma generate
COPY src ./src
COPY docker-entrypoint.sh ./
# /app/uploads is the only path the app writes to at runtime (also the mount
# point for the `uploads` named volume in docker-compose.yml) — everything
# else the image ships with is read-only to the app. node:22's image already
# has a low-privilege `node` user.
RUN mkdir -p /app/uploads && chown -R node:node /app/uploads

USER node
EXPOSE 4000
CMD ["npm", "start"]

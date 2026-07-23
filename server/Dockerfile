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
RUN mkdir -p /app/uploads

EXPOSE 4000
CMD ["npm", "start"]

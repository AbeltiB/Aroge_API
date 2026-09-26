FROM node:22-bookworm-slim

# Prisma's engine needs to detect the system's OpenSSL version at `generate`
# time — bookworm-slim doesn't ship openssl by default, so without this it
# silently guesses openssl-1.1.x and can fail to load the query engine at
# runtime.
# curl is required by Coolify's container healthcheck, which execs into the
# running container to hit the health endpoint rather than probing it from
# outside.
RUN apt-get update -y && apt-get install -y openssl curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
EXPOSE 4000

CMD ["node", "dist/index.js"]

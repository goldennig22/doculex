# syntax=docker/dockerfile:1
# DocuLex production image. Built in GitLab CI, tagged with the commit SHA, pulled by the VPS.

# 1. Build: needs devDependencies (TypeScript).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# 2. Production dependencies only: no TypeScript, eslint, vitest or drizzle-kit in the final image.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# 3. Runtime.
FROM node:22-alpine
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle
# tsc only emits .js: the demo page is read from /app/public at startup, and the app won't boot without it
COPY public ./public
COPY package.json ./
# Never run as root: a compromised process can't write outside what `node` owns.
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]

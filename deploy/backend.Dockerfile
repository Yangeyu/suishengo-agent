FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS base
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.26.0 --activate

FROM base AS build
ARG NPM_REGISTRY=https://registry.npmjs.org
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/backend/package.json ./apps/backend/package.json
COPY apps/frontend/package.json ./apps/frontend/package.json
RUN pnpm install --frozen-lockfile --registry="$NPM_REGISTRY"
COPY . .
RUN pnpm build:backend

FROM base AS dependencies
ARG NPM_REGISTRY=https://registry.npmjs.org
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts --registry="$NPM_REGISTRY"

FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4400
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./package.json
USER node
EXPOSE 4400
CMD ["node", "dist/apps/backend/src/main.js"]

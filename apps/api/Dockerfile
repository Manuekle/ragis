# syntax=docker/dockerfile:1.7
# Producción: fijar imágenes por digest (node:24-alpine@sha256:...).
FROM node:24-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @ragsis/api
COPY apps/api apps/api
RUN pnpm --filter @ragsis/api build \
 && pnpm --filter @ragsis/api deploy --prod --legacy /out \
 && cp -r apps/api/dist /out/dist

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/dist ./dist
COPY --from=build /out/package.json ./package.json
COPY db/migrations ./db/migrations
USER node
EXPOSE 4000
CMD ["node", "dist/server.js"]

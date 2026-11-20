# syntax=docker/dockerfile:1.7
FROM node:24-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @ragsis/web
COPY apps/web apps/web
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @ragsis/web build

FROM node:24-alpine
# The runtime only runs `node`. The package managers bundled in the base image
# (npm, npx, corepack, yarn) are never used here, and npm ships its own
# dependency tree (brace-expansion, undici, ...) that Trivy flags; drop them.
RUN rm -rf /usr/local/lib/node_modules /opt/yarn-* \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public
# The runtime user is non-root; source assets can carry restrictive local modes.
RUN chmod -R a+rX /app/apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]

# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=24.19.0
ARG PNPM_VERSION=11.21.0

FROM node:${NODE_VERSION}-bookworm-slim AS build
ARG PNPM_VERSION
ENV PNPM_HOME=/opt/pnpm
ENV PATH=${PNPM_HOME}:${PATH}
WORKDIR /workspace
RUN corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @mail-edge/reference-service... build
RUN pnpm --filter @mail-edge/reference-service deploy --prod /opt/reference-service

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /srv/reference-service
COPY --from=build --chown=10001:10001 /opt/reference-service/ ./
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/livez').then((response)=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "--enable-source-maps", "./dist/main.js"]

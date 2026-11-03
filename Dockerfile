# syntax=docker/dockerfile:1
# Build the same npm package that gets published, then install it into a slim runtime image.
FROM node:22-bookworm-slim AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json tsconfig.json LICENSE ./
COPY config ./config
COPY packages ./packages
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile
RUN pnpm build && mkdir /out && cd packages/mcp && npm pack --pack-destination /out

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    CLOSELOOP_DB=/state/closeloop.db
COPY --from=build /out/closeloop-mcp-*.tgz /tmp/
RUN npm install -g /tmp/closeloop-mcp-*.tgz --no-audit --no-fund && rm /tmp/*.tgz && npm cache clean --force \
 && useradd --create-home --uid 10001 closeloop && mkdir -p /state /data && chown closeloop /state
USER closeloop
WORKDIR /home/closeloop
VOLUME ["/state"]
# MCP over stdio: run with `docker run -i`. Subcommands: `check`, `seed PATH`.
ENTRYPOINT ["closeloop-mcp"]

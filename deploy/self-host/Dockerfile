FROM node:22-bookworm-slim AS build
WORKDIR /app

# Copy explicit build inputs, never local credentials, Git state, or agent history.
COPY package.json package-lock.json tsconfig.json ./
# Control-server image only: it relays tools and does not need the agent's
# ripgrep download. Agent source setup explicitly rebuilds @vscode/ripgrep.
RUN npm ci --ignore-scripts
COPY src ./src
COPY scripts ./scripts
COPY setup-claude-server.js uninstall-claude-server.js track-installation.js ./
RUN npm run build
RUN npm prune --omit=dev --ignore-scripts

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node LICENSE ./LICENSE
RUN mkdir -p /data && chown node:node /data && chmod 700 /data
USER node
VOLUME ["/data"]
EXPOSE 8787
ENTRYPOINT ["node", "dist/self-host/cli.js"]
CMD ["serve", "--data-dir", "/data"]

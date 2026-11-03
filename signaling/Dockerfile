# The signaling server. Built from the repo root, because it's an npm
# workspace: `docker build -f signaling/Dockerfile .`
FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /app

# The workspace manifests first, so dependency layers are cached between
# builds that only change source code. Every workspace's package.json is
# needed for `npm ci` to match the lockfile, even the ones not installed.
COPY package.json package-lock.json ./
COPY protocol/package.json protocol/
COPY signaling/package.json signaling/
COPY client/package.json client/
RUN npm ci --workspace signaling --omit=dev --ignore-scripts && npm cache clean --force

# Node 24 runs the TypeScript directly, as in development: no build step.
# protocol/ holds types only, erased at load time.
COPY protocol/ protocol/
COPY signaling/src/ signaling/src/

# The room registry lives on a volume mounted here (STATE_DIR).
RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 8080
CMD ["node", "signaling/src/index.ts"]

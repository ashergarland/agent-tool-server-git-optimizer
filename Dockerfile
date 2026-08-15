FROM node:22-alpine AS build
WORKDIR /workspace

COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build \
  && npm ci --omit=dev --ignore-scripts \
  && npm cache clean --force

FROM node:22-alpine AS runtime
ARG GIT_SHA=unknown
ARG SERVICE_VERSION=0.0.0-dev
# Set to an exact Alpine package version (for example 2.49.1-r0) for a bit-reproducible image.
ARG GIT_ALPINE_VERSION=""
# Minimum Git that supports --end-of-options, GIT_CONFIG_GLOBAL, and GIT_CONFIG_SYSTEM.
ARG GIT_MINIMUM_VERSION=2.34

# Git is a hard runtime dependency: the server can do nothing without it.
RUN set -eu; \
  if [ -n "$GIT_ALPINE_VERSION" ]; then \
    apk add --no-cache "git=$GIT_ALPINE_VERSION"; \
  else \
    apk add --no-cache git; \
  fi; \
  installed="$(git --version | awk '{print $3}')"; \
  required_major="${GIT_MINIMUM_VERSION%%.*}"; \
  required_minor="${GIT_MINIMUM_VERSION#*.}"; \
  major="${installed%%.*}"; rest="${installed#*.}"; minor="${rest%%.*}"; \
  if [ "$major" -lt "$required_major" ] || \
     { [ "$major" -eq "$required_major" ] && [ "$minor" -lt "$required_minor" ]; }; then \
    echo "Git $installed is older than the required $GIT_MINIMUM_VERSION" >&2; \
    exit 1; \
  fi; \
  echo "Pinned Git $installed"

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    GIT_SHA=${GIT_SHA} \
    SERVICE_VERSION=${SERVICE_VERSION} \
    GIT_EXECUTABLE=/usr/bin/git
WORKDIR /app

COPY --from=build --chown=node:node /workspace/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/dist ./dist
COPY --chown=node:node package.json ./

USER node
EXPOSE 8080
# The image needs no writable layer beyond temporary space:
#   docker run --read-only --tmpfs /tmp ... -v /srv/repositories:/repositories:ro
VOLUME ["/tmp"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/index.js"]

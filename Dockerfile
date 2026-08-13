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
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    GIT_SHA=${GIT_SHA} \
    SERVICE_VERSION=${SERVICE_VERSION}
WORKDIR /app

COPY --from=build --chown=node:node /workspace/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/dist ./dist
COPY --chown=node:node package.json ./

USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/index.js"]

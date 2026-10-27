# --- Build stage: install all deps, build TS, generate icons ---
FROM node:22.23.4-bookworm-slim AS build
WORKDIR /app
# node:22 bundles npm 10, which runs an implicit `node-gyp rebuild` for any package that ships a
# binding.gyp and no install script — but only when a lockfile is present. better-sqlite3 13
# is exactly that shape (it dropped prebuild-install in favour of prebuilds inside the tarball),
# so `npm ci` tries to compile it and fails on the missing Python toolchain. npm 12 doesn't.
# Keep this in both stages; drop it once the base image ships npm >= 12.
RUN npm install -g npm@12.0.2
COPY package*.json ./
RUN npm ci
COPY . .
# A ward's own building for the icons: `--build-arg ICON_MASK=my-building.png`, a mask in art/ (see
# art/README.md). Unset, the generic meetinghouse. `icon.local.json` is kept out of the image
# (.dockerignore), so this is the one way to choose; the generator reads ICON_MASK from the env.
ARG ICON_MASK=
RUN npm run build

# --- Runtime stage: production deps only ---
FROM node:22.23.4-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app

# Production dependencies. better-sqlite3 ships prebuilt binaries inside its tarball (so this
# needs no compiler and no build-time fetch from GitHub) — but see the npm note in the build
# stage: npm 10 would try to compile it anyway.
RUN npm install -g npm@12.0.2
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public

ENV PORT=3000 \
    DATABASE_PATH=/data/app.db
EXPOSE 3000
# Run as the unprivileged `node` user (uid/gid 1000) the official image provides, not root. /data is
# created and handed to it here, before VOLUME: a fresh named volume copies the image's mount point,
# ownership included, so the app can create app.db and uploads/ in it.
RUN mkdir -p /data && chown node:node /data
USER node
# Mount a persistent volume here so subscriptions survive redeploys.
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]

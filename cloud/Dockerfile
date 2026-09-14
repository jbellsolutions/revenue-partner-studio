FROM node:22.22.3-bookworm-slim AS website
WORKDIR /app/site
COPY site/package.json site/package-lock.json ./
RUN npm ci --ignore-scripts --workspaces=false
COPY site ./
COPY brand /app/brand
COPY ["docs/BEFORE-YOU-START.md", "docs/SETUP-PROMPT.txt", "docs/Revenue Partner Studio - Before You Start.docx", "/app/docs/"]
COPY apps/desktop/src/app/bot-product/shell.css /app/apps/desktop/src/app/bot-product/shell.css
RUN npm run build

FROM node:22.22.3-bookworm-slim AS build
WORKDIR /app/cloud
COPY cloud/package.json cloud/package-lock.json ./
RUN npm ci --ignore-scripts --workspaces=false
COPY cloud ./
COPY brand /app/brand
COPY apps/desktop/src/app/bot-product/shell.css /app/apps/desktop/src/app/bot-product/shell.css
COPY apps/desktop/src/lib/model-search-text.ts /app/apps/desktop/src/lib/model-search-text.ts
RUN npm run typecheck && npm run build && npm prune --omit=dev --ignore-scripts --workspaces=false
COPY . /app/source
RUN node /app/source/distribution/package-runtime.mjs /app/source /app/cloud/dist/setup

FROM node:22.22.3-bookworm-slim
ENV NODE_ENV=production PORT=8788 STUDIO_DATA_DIR=/data
WORKDIR /app
COPY --from=build /app/cloud/dist ./dist
COPY --from=website /app/site/dist ./dist/website
COPY --from=build /app/cloud/node_modules ./node_modules
COPY --from=build /app/cloud/package.json ./package.json
EXPOSE 8788
CMD ["node", "dist/server.mjs"]

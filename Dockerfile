# TDM CRM: one container serves the API and the web app. SQLite lives on a mounted volume at /data.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm install
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080 DB_PATH=/data/tdm.db
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/package.json ./server/
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist
RUN mkdir -p /data
VOLUME /data
EXPOSE 8080
WORKDIR /app/server
CMD ["sh", "-c", "node dist/seed.js && node dist/index.js"]

# Root-level image for one-click hosts (Railway, Render, Fly...). Builds only the server.
# Attach a persistent volume at /data so accounts and devices survive redeploys.
FROM node:22-alpine
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/src ./src
COPY server/public ./public
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data TRUST_PROXY=1
EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]

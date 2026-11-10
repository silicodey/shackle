FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data TRUST_PROXY=1
VOLUME /data
EXPOSE 8080
USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]

FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js index.js ./
ENV PORT=8787 DATA_DIR=/data ALLOW_STORE_FORWARD=false
VOLUME /data
EXPOSE 8787
USER node
CMD ["node", "index.js"]

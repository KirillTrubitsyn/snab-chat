FROM node:20-alpine
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY . ./
RUN npm run build

# Remove dev dependencies after build
RUN npm prune --omit=dev

EXPOSE 3001
CMD ["node", "dist/index.js"]

HEALTHCHECK --interval=30s --timeout=5s \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/health || exit 1

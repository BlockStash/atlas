# Build context is the repository root:  docker build -f backend/Dockerfile .
FROM node:24-bookworm-slim AS build
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci
COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN npm run build

FROM node:24-bookworm-slim AS deps
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci --omit=dev

FROM node:24-bookworm-slim
ENV PORT=4000
WORKDIR /app/backend
COPY --from=deps /app/backend/node_modules ./node_modules
COPY --from=build /app/backend/dist ./dist
COPY backend/package.json ./
COPY backend/config ./config
# The backend reads the deployed contract manifest and ABIs from ../contracts.
COPY contracts/deployments /app/contracts/deployments
COPY contracts/abi /app/contracts/abi
RUN mkdir -p data && chown -R node:node /app
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]

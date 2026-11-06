# Build context is the repository root:  docker build -f frontend/Dockerfile .
FROM node:24-bookworm-slim AS build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend ./
# Next.js bakes rewrites and NEXT_PUBLIC_* values in at build time.
ARG BACKEND_URL=http://backend:4000
ARG NEXT_PUBLIC_DEMO_WORLD_ID=false
ARG NEXT_PUBLIC_DEMO_WALLET=false
ARG NEXT_PUBLIC_SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
ARG NEXT_PUBLIC_INTENT_DEMO_MODE=true
ARG NEXT_PUBLIC_ADMIN_URL=http://127.0.0.1:3001
ARG NEXT_PUBLIC_ARKIV_EXPLORER_URL=https://rabdi.explorer.arkiv.network
ENV BACKEND_URL=$BACKEND_URL \
    NEXT_PUBLIC_DEMO_WORLD_ID=$NEXT_PUBLIC_DEMO_WORLD_ID \
    NEXT_PUBLIC_DEMO_WALLET=$NEXT_PUBLIC_DEMO_WALLET \
    NEXT_PUBLIC_SEPOLIA_RPC_URL=$NEXT_PUBLIC_SEPOLIA_RPC_URL \
    NEXT_PUBLIC_INTENT_DEMO_MODE=$NEXT_PUBLIC_INTENT_DEMO_MODE \
    NEXT_PUBLIC_ADMIN_URL=$NEXT_PUBLIC_ADMIN_URL \
    NEXT_PUBLIC_ARKIV_EXPLORER_URL=$NEXT_PUBLIC_ARKIV_EXPLORER_URL \
    NEXT_TELEMETRY_DISABLED=1
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
WORKDIR /app/frontend
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build --chown=node:node /app/frontend ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
CMD ["node_modules/.bin/next", "start", "--hostname", "0.0.0.0", "--port", "3000"]

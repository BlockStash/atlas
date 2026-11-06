# Build context is the repository root:  docker build -f admin/Dockerfile .
FROM node:24-bookworm-slim AS build
WORKDIR /app/admin
COPY admin/package*.json ./
RUN npm ci
COPY admin ./
RUN npm run build

FROM nginx:1.27-alpine
COPY admin/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/admin/dist /usr/share/nginx/html
EXPOSE 80

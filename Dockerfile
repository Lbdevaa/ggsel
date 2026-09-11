# Один образ на три сервиса: api, supplier-a, supplier-b. Команда задаётся в compose.
FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY suppliers/package.json suppliers/
RUN npm ci --omit=dev

COPY backend backend
COPY suppliers suppliers
COPY frontend frontend
COPY scripts scripts

EXPOSE 3300 4001 4002
CMD ["node", "backend/src/server.js"]

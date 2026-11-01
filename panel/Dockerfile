FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY angular.json tsconfig.json tsconfig.app.json ./
COPY public ./public
COPY src ./src
RUN npx ng build

FROM nginx:1.29-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/panel/browser /usr/share/nginx/html
# Al arrancar, escribe config.js con la URL de la API (variable RELEVO_API)
COPY config.sh /docker-entrypoint.d/40-relevo-config.sh

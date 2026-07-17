FROM node:24-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV APP_ENV=production
ENV NODE_NO_WARNINGS=1

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

EXPOSE 8787

CMD ["npm", "run", "start:prod"]

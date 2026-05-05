FROM node:24-alpine

RUN apk add --no-cache rclone

RUN npm install -g granola-cli

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
COPY prompts/ ./prompts/

RUN npm run build

CMD ["node", "dist/index.js"]

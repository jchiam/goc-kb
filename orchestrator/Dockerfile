FROM --platform=linux/amd64 node:24-alpine

RUN sed -i 's/https/http/g' /etc/apk/repositories && \
    apk add --no-cache ca-certificates rclone && \
    update-ca-certificates

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
COPY prompts/ ./prompts/

RUN npm run build

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]

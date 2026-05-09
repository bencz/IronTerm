FROM node:lts-alpine

WORKDIR /app

RUN npm install -g serve@latest

COPY public/ ./public/

ENV PORT=8080
EXPOSE 8080

CMD ["sh", "-c", "serve -s public -l tcp://0.0.0.0:${PORT}"]

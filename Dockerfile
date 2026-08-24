FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080

COPY --chown=node:node package.json ./
COPY --chown=node:node server/ ./server/
COPY --chown=node:node public/ ./public/

USER node

EXPOSE 8080

CMD ["npm", "start"]

FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
RUN mkdir /app/data && chown node:node /app/data
USER node
ENV HOST=0.0.0.0 PORT=3000 DATABASE_PATH=/app/data/wasselha.sqlite
EXPOSE 3000
VOLUME ["/app/data"]
CMD ["node", "src/server.mjs"]

# Build context = repository root:  docker build -f services/interpreter-bridge/Dockerfile .
FROM node:22-slim
WORKDIR /app
COPY services/interpreter-bridge/package.json services/interpreter-bridge/
RUN cd services/interpreter-bridge && npm install --omit=dev
COPY services/interpreter-bridge services/interpreter-bridge
COPY supabase/functions/_shared/interpreter supabase/functions/_shared/interpreter
COPY supabase/functions/_shared/i18n supabase/functions/_shared/i18n
USER node
EXPOSE 8080
CMD ["node", "services/interpreter-bridge/server.mjs"]

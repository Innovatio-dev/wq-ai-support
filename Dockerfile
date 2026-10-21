# The AI support service: plain Node, no build step. The image is the source tree minus
# dev tooling, docs and tests; config comes from the ECS task definition at runtime
# (infra/terraform), never from a baked-in .env.

ARG NODE_VERSION=22-bookworm-slim
# Docker Hub's official node image via AWS's public mirror (same as the main app);
# CI can point NODE_IMAGE at a mirror if anonymous pulls get rate-limited.
ARG NODE_IMAGE=public.ecr.aws/docker/library/node

FROM ${NODE_IMAGE}:${NODE_VERSION}

ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY server.js ./
COPY src ./src
COPY public ./public
COPY prompts ./prompts
COPY kb ./kb

# data/ only receives tickets.jsonl in dev/demo; production forwards tickets to the main app.
# It still has to be writable so a misconfigured task fails loudly in the app, not on EACCES.
RUN mkdir -p data && chown node:node data

# Reported by /healthz so a deploy can verify the running task is this build.
ARG APP_COMMIT=""
ENV APP_COMMIT=${APP_COMMIT}

USER node
EXPOSE 3000
CMD ["node", "server.js"]

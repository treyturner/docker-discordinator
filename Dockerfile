# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:26-alpine
FROM ${NODE_IMAGE} AS build

RUN apk add --no-cache git ca-certificates
WORKDIR /opt/discordinator

# Override with a commit, tag, or branch to build a different upstream revision.
ARG DISCORDINATOR_REF=9207b1d253d8f61c7e350a9f1fe6db0962eeb6ec
RUN git init . \
    && git remote add origin https://github.com/DevL0rd/Discordinator.git \
    && git fetch --depth=1 origin "${DISCORDINATOR_REF}" \
    && git checkout --detach FETCH_HEAD \
    && rm -rf .git
COPY patches/configurable-bind-host.patch /tmp/configurable-bind-host.patch
RUN git apply --check /tmp/configurable-bind-host.patch \
    && git apply /tmp/configurable-bind-host.patch \
    && rm /tmp/configurable-bind-host.patch
RUN npm ci --ignore-scripts \
    && npm run build \
    && rm -rf .npm-cache

FROM ${NODE_IMAGE}
RUN apk add --no-cache bash ca-certificates git tini

# These CLIs support the wizard's local responders. Sign in at runtime.
ARG CODEX_VERSION=latest
ARG CLAUDE_CODE_VERSION=latest
RUN npm install --global "@openai/codex@${CODEX_VERSION}" "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && npm cache clean --force

# Keep build dependencies: connecting Claude's plugin rebuilds upstream sources.
COPY --from=build --chown=node:node /opt/discordinator /opt/discordinator
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN mkdir -p /data/app /data/home && chown -R node:node /data

ENV HOME=/data/home \
    DISCORDINATOR_APP_HOME=/data/app \
    DISCORDINATOR_BIND_HOST=0.0.0.0
EXPOSE 8787
WORKDIR /data/app
USER node
VOLUME ["/data"]
ENTRYPOINT ["/sbin/tini", "-g", "--", "docker-entrypoint.sh"]
CMD ["run"]

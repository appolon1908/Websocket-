FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS build
ARG VCS_REF=unknown
ARG VITE_APP_ENV=staging
ARG VITE_SAFE_MODE=false
ARG VITE_MOCK_MODE=false
ARG VITE_DISABLE_LIVE_INTEGRATIONS=false
ARG VITE_SIP_ENABLED=true
ARG VITE_WEBRTC_ENABLED=true
ARG VITE_TEST_SYN_ONLY=true
ARG VITE_PRODUCTION_PSTN=false
ARG VITE_WSS_URL=wss://wss.codestra.agency:8089/ws
ENV VITE_APP_ENV=$VITE_APP_ENV \
    VITE_SAFE_MODE=$VITE_SAFE_MODE \
    VITE_MOCK_MODE=$VITE_MOCK_MODE \
    VITE_DISABLE_LIVE_INTEGRATIONS=$VITE_DISABLE_LIVE_INTEGRATIONS \
    VITE_SIP_ENABLED=$VITE_SIP_ENABLED \
    VITE_WEBRTC_ENABLED=$VITE_WEBRTC_ENABLED \
    VITE_TEST_SYN_ONLY=$VITE_TEST_SYN_ONLY \
    VITE_PRODUCTION_PSTN=$VITE_PRODUCTION_PSTN \
    VITE_WSS_URL=$VITE_WSS_URL
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
RUN npm run build
FROM golang:1.26-alpine@sha256:3889b425f035be855a72fb4755265311293b6d414521f0a519d819df32222d83 AS caddy-build
WORKDIR /src
RUN go mod init codestra.invalid/caddy-build \
 && go get github.com/caddyserver/caddy/v2/cmd/caddy@v2.11.4 \
 && go get golang.org/x/net@v0.56.0 golang.org/x/text@v0.39.0 google.golang.org/grpc@v1.82.1 \
 && CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /runtime/usr/bin/caddy github.com/caddyserver/caddy/v2/cmd/caddy \
 && mkdir -p /runtime/tmp/caddy/config /runtime/tmp/caddy/data \
 && chmod 1777 /runtime/tmp \
 && chmod 0700 /runtime/tmp/caddy /runtime/tmp/caddy/config /runtime/tmp/caddy/data

FROM scratch
ARG VCS_REF=unknown
LABEL org.opencontainers.image.source="https://github.com/Codestra-SRL/codestra-middleware" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.title="Codestra Agent Desktop"
ENV HOME=/tmp/caddy \
    XDG_CONFIG_HOME=/tmp/caddy/config \
    XDG_DATA_HOME=/tmp/caddy/data
COPY --from=caddy-build --chown=10001:10001 /runtime/ /
COPY --from=build /app/dist /usr/share/caddy
COPY Caddyfile /etc/caddy/Caddyfile
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["/usr/bin/caddy"]
CMD ["run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]

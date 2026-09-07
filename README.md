# Codestra agent real-time gateway

Authority for `wss://api.codestra.co/ws/agent` under issue [#257](https://github.com/appolon1908-hue/codestra-production-platform/issues/257). This service transports authorized call-state and screen-pop events only; it does not carry SIP/WebRTC signaling or audio.

The gateway fails startup unless the Middleware ticket-consumption endpoint, a service credential, and an exact origin allowlist are configured. Middleware owns durable, atomic one-use ticket consumption. Identity is taken only from the consumed ticket response; query/header identity claims are ignored.

Contract version `1.0.0`, digest `b39cdffe56a8185c91174228f0423df68b1137f34875f6ee52f9914f904bf724`.

Required environment: `MIDDLEWARE_URL`, `MIDDLEWARE_SERVICE_TOKEN`, `ALLOWED_ORIGINS`. Optional: `LISTEN_ADDR`, `MAX_CONNECTIONS`, `SOURCE_SHA`, `IMAGE_DIGEST`.

Middleware transport and 5xx failures return HTTP 503 with `Retry-After`. A client must obtain a new one-use ticket before reconnecting because an ambiguous consume may already have invalidated the prior ticket.

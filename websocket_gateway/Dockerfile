ARG CHAINGUARD_PYTHON_DEV=cgr.dev/chainguard/python@sha256:4bf7e945777010672b8ccd5d2ae2c41c91ad6d3478878347c731ae536d506bef
ARG CHAINGUARD_PYTHON_RUNTIME=cgr.dev/chainguard/python@sha256:1f6779775c9f466890da563e411cb677045a6c20b6a65160eefad1deffb5012c

FROM ${CHAINGUARD_PYTHON_DEV} AS builder
USER 0
WORKDIR /build
COPY requirements.lock ./
RUN python -m venv /opt/venv \
 && /opt/venv/bin/python -m pip install --no-cache-dir --disable-pip-version-check \
      --require-hashes -r requirements.lock \
 && /opt/venv/bin/python -m pip uninstall -y pip setuptools wheel

FROM ${CHAINGUARD_PYTHON_RUNTIME}
ARG VCS_REF=unknown
LABEL org.opencontainers.image.source="https://github.com/Codestra-SRL/codestra-middleware" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.title="Codestra WebSocket Gateway" \
      org.opencontainers.image.base.name="cgr.dev/chainguard/python@sha256:1f6779775c9f466890da563e411cb677045a6c20b6a65160eefad1deffb5012c"
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PATH="/opt/venv/bin:${PATH}"
COPY --from=builder --chown=10001:10001 /opt/venv /opt/venv
WORKDIR /app
COPY --chown=10001:10001 app.py migrate.py ./
COPY --chown=10001:10001 migrations ./migrations
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=2)"]
ENTRYPOINT []
CMD ["/opt/venv/bin/python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080", "--ws-ping-interval", "25", "--ws-ping-timeout", "10", "--timeout-graceful-shutdown", "10", "--no-access-log"]

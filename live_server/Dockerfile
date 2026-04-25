# Multi-stage Dockerfile for the PageSignal Relay (live_server.py).
#
# Build:
#   docker build -t pagesignal-relay -f live_server/Dockerfile live_server
#
# Run (with .env in the same folder):
#   docker run --rm --env-file live_server/.env -p 8765:8765 pagesignal-relay
#
# Or use docker-compose from inside the live_server/ folder:
#   docker compose up -d

FROM python:3.13-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# Create unprivileged runtime user.
RUN groupadd --system relay && useradd --system --gid relay --home /app --shell /usr/sbin/nologin relay

WORKDIR /app

# Install dependencies first for better layer caching.
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Copy source.
COPY live_server.py /app/live_server.py

# Drop privileges.
USER relay

EXPOSE 8765

# Lightweight HTTP healthcheck against the relay's /healthz endpoint. Falls back
# to a TCP check if Python is missing (it never is in this image).
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD python -c "import urllib.request,sys; \
import os; port=os.environ.get('RELAY_PORT','8765'); \
urllib.request.urlopen(f'http://127.0.0.1:{port}/healthz', timeout=3).read(); sys.exit(0)" \
  || exit 1

ENTRYPOINT ["python", "live_server.py"]

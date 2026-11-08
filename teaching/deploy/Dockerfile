# Frontend JS and fonts are tracked build output; Node is only needed when developing UI.
FROM eclipse-temurin:17-jdk-jammy AS java-build
WORKDIR /build
COPY . .
RUN sh teaching/scripts/build.sh

FROM python:3.12-slim-bookworm AS gateway
RUN apt-get update && apt-get install -y --no-install-recommends openjdk-17-jre-headless \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 10001 --create-home mars
WORKDIR /app
COPY --from=java-build /build/teaching/build/classes ./teaching/build/classes
COPY teaching/examples ./teaching/examples
COPY teaching/hosting ./teaching/hosting
USER 10001:10001
ENV MARS_BIND=0.0.0.0 MARS_PORT=8767 PYTHONDONTWRITEBYTECODE=1
EXPOSE 8767
CMD ["python3", "teaching/hosting/gateway.py"]

FROM caddy:2-alpine AS web
COPY teaching/web /srv
COPY teaching/deploy/Caddyfile /etc/caddy/Caddyfile

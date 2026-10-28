# syntax=docker/dockerfile:1
#
# Shrok's image: Debian trixie, Debian's chromium, UID 10001, data in /data.
#
#   docker buildx build -f packaging/oci/Dockerfile --platform linux/amd64,linux/arm64 -t shrok .
#
# Its sandbox and browser need user namespaces, so run it with packaging/oci/seccomp.json and
# systempaths=unconfined, plus packaging/oci/apparmor/shrok-container on hosts with AppArmor. compose.yaml
# shows how.

# Pinned by digest, so a moved tag cannot change what the image is built from. Update both together.
ARG DEBIAN=debian:trixie-slim@sha256:89c1ea91e897f0fe0a3731595330bc45b8bdef4047464a07116f891a94054b31

FROM ${DEBIAN} AS build
RUN apt-get update \
 && apt-get upgrade -y \
 && apt-get install -y --no-install-recommends ca-certificates curl libatomic1 xz-utils \
 && rm -rf /var/lib/apt/lists/*
COPY . /src
RUN sh /src/packaging/app.sh /opt/shrok system-browser

FROM ${DEBIAN} AS runtime
RUN apt-get update \
 && apt-get upgrade -y \
 && apt-get install -y --no-install-recommends bubblewrap ca-certificates chromium libatomic1 ripgrep socat tini \
 && rm -rf /var/lib/apt/lists/* /var/log/apt/* /var/log/alternatives.log /var/log/dpkg.log /var/log/fontconfig.log \
 && rm -f /etc/localtime \
 && useradd --uid 10001 --user-group --create-home --home-dir /home/shrok --shell /usr/sbin/nologin shrok \
 && install -d -o 10001 -g 10001 -m 0700 /data
COPY --from=build /opt/shrok /opt/shrok
# The source label links the image to the repository on GHCR, so the package page shows it and its README.
LABEL org.opencontainers.image.source="https://github.com/bjoernaagaard/shrok" \
      org.opencontainers.image.description="Shrok, a personal assistant you talk to over SimpleX Chat" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
ENV PATH=/opt/shrok/bin:/opt/shrok/node/bin:$PATH \
    SHROK_DATA_DIR=/data
USER 10001
VOLUME /data
ENTRYPOINT ["tini", "--"]
CMD ["shrok", "run"]

# The runtime plus the end-to-end tests and the probe's tools, for .github/workflows/verify.yml.
FROM runtime AS verify
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends procps \
 && rm -rf /var/lib/apt/lists/*
COPY test /opt/shrok/app/test
ENV SIMPLEX_LIBS_DIR=/opt/shrok/lib/simplex \
    SIMPLEX_ADDON_PATH=/opt/shrok/lib/simplex-addon.node
WORKDIR /opt/shrok/app
USER 10001

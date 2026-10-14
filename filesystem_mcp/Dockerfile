# Home Assistant app image. The Supervisor builds it from this folder; the
# server, Everkeep, comes from npm, pinned below. Release: publish everkeep
# first, then change the pin here, `version` in config.yaml and the top entry
# of CHANGELOG.md together (tools/check-release.mjs).
FROM ghcr.io/home-assistant/base:3.24-2026.08.0

# The version has one source: config.yaml -> BUILD_VERSION (passed by the
# Supervisor) -> the label below and APP_VERSION, read by run.sh for the
# start banner.
ARG BUILD_VERSION=0.0.0-dev
ENV APP_VERSION=${BUILD_VERSION}

# Toolchain: nodejs (Everkeep), poppler-utils (pdfinfo, pdftoppm for PDF
# pages), sqlite (sqlite3 for sqlite_schema and sqlite_query, run with
# -readonly -safe), jq (run.sh). npm only for the install, removed after it.
#
# Packages are not pinned to an exact -rN release: Alpine removes old releases
# from the branch, and such a pin breaks installation. They float within the
# branch; toolchain-check.sh fails the build when a major version changes or
# the PDF, document or SQLite pipeline stops working.
#
# Not npm -g: it ignores --omit=optional, and the native @napi-rs/canvas must
# not be in the image (SIGILL on CPUs without AVX). npm may leave an empty
# node_modules/@napi-rs scope folder: removed if empty, then the build fails if
# it is still there. toolchain-check.sh runs through sh: a tarball packed on
# Windows has no exec bit.
RUN apk add --no-cache nodejs npm poppler-utils sqlite jq \
    && mkdir -p /opt/everkeep \
    && cd /opt/everkeep \
    && npm install --ignore-scripts --omit=optional --no-package-lock --no-save everkeep@1.0.0 \
    && ln -s /opt/everkeep/node_modules/.bin/everkeep /usr/local/bin/everkeep \
    && npm cache clean --force \
    && { rmdir /opt/everkeep/node_modules/@napi-rs 2>/dev/null || true; } \
    && ! test -e /opt/everkeep/node_modules/@napi-rs \
    && apk del npm \
    && sh /opt/everkeep/node_modules/everkeep/scripts/toolchain-check.sh build

COPY run.sh /run.sh
RUN chmod a+x /run.sh

LABEL \
  io.hass.version="${BUILD_VERSION}" \
  io.hass.type="addon" \
  io.hass.arch="amd64|aarch64"

CMD [ "/run.sh" ]

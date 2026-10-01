# Base image: an arch-less multi-arch manifest, resolved by buildx from
# --platform. A BUILD_FROM passed by the Supervisor overrides the default.
ARG BUILD_FROM=ghcr.io/home-assistant/base:3.22
FROM ${BUILD_FROM}

# The version has one source: config.yaml -> BUILD_VERSION (passed by the
# Supervisor) -> ADDON_VERSION, read by server.js, policy-ui.js and run.sh.
ARG BUILD_VERSION=0.0.0-dev
ENV ADDON_VERSION=${BUILD_VERSION}

# Toolchain: nodejs (the server, no npm dependencies), poppler-utils
# (pdftotext, pdftoppm, pdfinfo for the PDF tools) and sqlite (sqlite3 for
# sqlite_schema and sqlite_query, run with -readonly -safe).
#
# Packages are not pinned to an exact -rN release: Alpine removes old releases
# from the branch, and such a pin breaks installation. They float within the
# branch; toolchain-check.sh fails the build when a major version changes or
# the PDF or SQLite pipeline stops working.
RUN apk add --no-cache nodejs poppler-utils sqlite

COPY run.sh /run.sh
COPY toolchain-check.sh /toolchain-check.sh
COPY proxy.js /proxy.js
COPY server.js /server.js
COPY safepath.js /safepath.js
COPY policy.js /policy.js
COPY policy-ui.js /policy-ui.js
COPY retention.js /retention.js
COPY sqlite.js /sqlite.js
RUN chmod a+x /run.sh /toolchain-check.sh \
    && /toolchain-check.sh build

LABEL \
  io.hass.version="${BUILD_VERSION}" \
  io.hass.type="addon" \
  io.hass.arch="amd64|aarch64"

CMD [ "/run.sh" ]

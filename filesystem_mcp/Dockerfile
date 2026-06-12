ARG BUILD_FROM
FROM ${BUILD_FROM}

RUN apk add --no-cache nodejs npm poppler-utils

COPY run.sh /run.sh
COPY proxy.js /proxy.js
COPY server.js /server.js
RUN chmod a+x /run.sh

CMD [ "/run.sh" ]
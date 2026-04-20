ARG BUILD_FROM
FROM ${BUILD_FROM}

RUN apk add --no-cache nodejs npm

RUN npm install -g @modelcontextprotocol/server-filesystem supergateway

COPY run.sh /run.sh
COPY proxy.js /proxy.js
RUN chmod a+x /run.sh

CMD [ "/run.sh" ]
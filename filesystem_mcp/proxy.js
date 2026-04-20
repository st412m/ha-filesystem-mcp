const http = require('http');

const TOKEN = process.env.VAULT_TOKEN;
const UPSTREAM_PORT = 3099;
const LISTEN_PORT = 3100;
const PREFIX = `/private_${TOKEN}`;

const server = http.createServer((req, res) => {
  if (!req.url.startsWith(PREFIX)) {
    res.writeHead(401, {'Content-Type': 'text/plain'});
    res.end('Unauthorized\n');
    return;
  }

  const upstreamUrl = req.url.slice(PREFIX.length);
  const finalUrl = upstreamUrl.startsWith('/') ? upstreamUrl : '/' + upstreamUrl;

  const options = {
    hostname: '127.0.0.1',
    port: UPSTREAM_PORT,
    path: finalUrl,
    method: req.method,
    headers: req.headers,
  };

  const proxy = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  req.pipe(proxy, { end: true });
  proxy.on('error', () => {
    res.writeHead(502);
    res.end('Bad Gateway\n');
  });
});

server.listen(LISTEN_PORT, () => {
  console.log(`Auth proxy on port ${LISTEN_PORT}`);
});

const http = require('http');

const TOKEN = process.env.VAULT_TOKEN;
const UPSTREAM_PORT = 3099;
const LISTEN_PORT = 3100;
const PREFIX = `/private_${TOKEN}`;
const LOG_REQUESTS = process.env.LOG_REQUESTS === 'true';

// Never let a secret (ours or a client's misconfigured old one) reach the log.
function maskPath(url) {
  return url.replace(/\/private_[^/?]+/g, '/private_***').slice(0, 120);
}

function clientIp(req) {
  return req.headers['cf-connecting-ip']
    || (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket.remoteAddress
    || '-';
}

function logLine(req, status, bytes, note) {
  if (!LOG_REQUESTS) return;
  const ua = req.headers['user-agent'] || '-';
  console.log(
    `[req] ${new Date().toISOString()} ${clientIp(req)} ${req.method} ${maskPath(req.url)} -> ${status} ${bytes}B ua="${ua}"${note ? ' ' + note : ''}`
  );
}

const server = http.createServer((req, res) => {
  if (!req.url.startsWith(PREFIX)) {
    res.writeHead(401, { 'Content-Type': 'text/plain' });
    res.end('Unauthorized\n');
    logLine(req, 401, 13, '(unauthorized)');
    return;
  }

  const upstreamUrl = req.url.slice(PREFIX.length);
  const finalUrl = upstreamUrl.startsWith('/') ? upstreamUrl : '/' + upstreamUrl;

  // 2.6.0: an allow-list instead of blind forwarding. Until now this proxy cut
  // the token prefix off and passed whatever was left to 3099, so every route
  // the server ever grows is published on the internet the moment it exists —
  // that is how POST /write came to be reachable from outside. The MCP endpoint
  // is the only thing that belongs out here; the policy page is on its own port
  // behind ingress and must never be reachable through this path.
  if (finalUrl.split('?')[0] !== '/mcp') {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found\n');
    logLine(req, 404, 10, '(not allowed)');
    return;
  }

  const options = {
    hostname: '127.0.0.1',
    port: UPSTREAM_PORT,
    path: finalUrl,
    method: req.method,
    headers: req.headers,
  };

  const proxy = http.request(options, (proxyRes) => {
    let bytes = 0;
    if (LOG_REQUESTS) proxyRes.on('data', (chunk) => { bytes += chunk.length; });
    proxyRes.on('end', () => logLine(req, proxyRes.statusCode, bytes));
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  req.pipe(proxy, { end: true });
  proxy.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end('Bad Gateway\n');
    logLine(req, 502, 12, '(upstream error)');
  });
});

server.listen(LISTEN_PORT, () => {
  console.log(`Auth proxy on port ${LISTEN_PORT}${LOG_REQUESTS ? ' (request logging ON)' : ''}`);
});

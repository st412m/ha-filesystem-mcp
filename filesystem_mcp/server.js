#!/usr/bin/env node
/**
 * Vault MCP Server — StreamableHTTP транспорт
 * Полная замена supergateway + @modelcontextprotocol/server-filesystem
 * Добавляет: read_pdf_page с поддержкой векторных PDF через SVG
 */

const http = require('http');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ALLOWED_DIR = path.resolve(process.argv[2] || '/media/VAULT');
const PORT = parseInt(process.argv[3] || '3099');

function resolveSafe(p) {
  const resolved = path.resolve(p);
  if (!resolved.startsWith(ALLOWED_DIR)) throw new Error(`Access denied: ${p}`);
  return resolved;
}

async function pdfPageCount(p) {
  return new Promise(resolve => {
    execFile('pdfinfo', [p], (err, stdout) => {
      const m = (stdout || '').match(/Pages:\s+(\d+)/);
      resolve(m ? parseInt(m[1]) : 1);
    });
  });
}

async function isVectorPdf(p) {
  return new Promise(resolve => {
    execFile('pdfimages', ['-list', p], (err, stdout) => {
      const lines = (stdout || '').trim().split('\n')
        .filter(l => l && !l.startsWith('page') && !l.startsWith('-') && l.trim());
      resolve(lines.length === 0);
    });
  });
}

async function pdfPageToImage(p, n) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vmcp-'));
  try {
    await new Promise((res, rej) => execFile('pdftoppm', [
      '-jpeg', '-r', '120', '-scale-to', '1400',
      '-f', String(n), '-l', String(n),
      p, path.join(tmp, 'page')
    ], e => e ? rej(e) : res()));
    const files = fs.readdirSync(tmp).filter(f => f.endsWith('.jpg')).sort();
    if (!files.length) throw new Error('pdftoppm: no output');
    return { type: 'image', data: fs.readFileSync(path.join(tmp, files[0])).toString('base64'), mimeType: 'image/jpeg' };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

async function pdfPageToSvg(p, n) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vmcp-'));
  try {
    await new Promise((res, rej) => execFile('pdftocairo', [
      '-svg', '-f', String(n), '-l', String(n),
      p, path.join(tmp, 'page')
    ], e => e ? rej(e) : res()));
    const files = fs.readdirSync(tmp).filter(f => f.startsWith('page')).sort();
    if (!files.length) throw new Error('pdftocairo: no output');
    const raw = fs.readFileSync(path.join(tmp, files[0]), 'utf8'); const compressed = raw.replace(/\s+/g, ' ').replace(/> </g, '><').trim(); return { type: 'text', text: compressed };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

async function renderPdfPage(p, n) {
  const vector = false;
  return vector ? pdfPageToSvg(p, n) : pdfPageToImage(p, n);
}

function mimeType(ext) {
  const map = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
    '.ogg': 'audio/ogg', '.flac': 'audio/flac',
  };
  return map[ext.toLowerCase()] || 'application/octet-stream';
}

function listDir(p) {
  return fs.readdirSync(p, { withFileTypes: true })
    .map(e => `${e.isDirectory() ? '[DIR]' : '[FILE]'} ${e.name}`).join('\n');
}

function listDirWithSizes(p, sortBy = 'name') {
  const entries = fs.readdirSync(p, { withFileTypes: true });
  const items = entries.map(e => {
    const full = path.join(p, e.name);
    let size = 0;
    try { size = e.isFile() ? fs.statSync(full).size : 0; } catch {}
    return { isDir: e.isDirectory(), name: e.name, size };
  });
  if (sortBy === 'size') items.sort((a, b) => b.size - a.size);
  else items.sort((a, b) => a.name.localeCompare(b.name));
  const lines = items.map(i =>
    `${i.isDir ? '[DIR]' : '[FILE]'} ${i.name}${i.isDir ? '' : '  ' + (i.size / 1024).toFixed(2) + ' KB'}`
  );
  const total = items.filter(i => !i.isDir).reduce((s, i) => s + i.size, 0);
  return lines.join('\n') + `\n\nTotal: ${items.filter(i => !i.isDir).length} files, ${items.filter(i => i.isDir).length} directories\nCombined size: ${(total / 1024).toFixed(2)} KB`;
}

function dirTree(p, level = 0) {
  if (level > 2) return '';
  const indent = '  '.repeat(level);
  return fs.readdirSync(p, { withFileTypes: true }).map(e => {
    const line = `${indent}${e.isDirectory() ? '[DIR]' : '[FILE]'} ${e.name}`;
    if (e.isDirectory() && level < 2) {
      const sub = dirTree(path.join(p, e.name), level + 1);
      return line + (sub ? '\n' + sub : '');
    }
    return line;
  }).join('\n');
}

const TOOLS = [
  {
    name: 'read_text_file',
    description: 'Read the complete contents of a file as text. Supports head/tail line limits.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, head: { type: 'number' }, tail: { type: 'number' } }, required: ['path'] }
  },
  {
    name: 'read_file',
    description: 'Read complete contents of a file as text. DEPRECATED: use read_text_file.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, head: { type: 'number' }, tail: { type: 'number' } }, required: ['path'] }
  },
  {
    name: 'read_media_file',
    description: 'Read an image, audio, or PDF file. For PDFs returns page 1 as image/SVG and total page count.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  },
  {
    name: 'read_pdf_page',
    description: 'Read a specific page of a PDF file. Vector PDFs return SVG text, raster PDFs return JPEG image. Use after read_media_file tells you the total page count.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the PDF file' },
        page: { type: 'number', description: 'Page number, 1-based' }
      },
      required: ['path', 'page']
    }
  },
  {
    name: 'read_multiple_files',
    description: 'Read multiple files simultaneously.',
    inputSchema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } } }, required: ['paths'] }
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a file with given content.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] }
  },
  {
    name: 'edit_file',
    description: 'Make targeted edits to a file using oldText/newText pairs.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        edits: { type: 'array', items: { type: 'object', properties: { oldText: { type: 'string' }, newText: { type: 'string' } }, required: ['oldText', 'newText'] } },
        dryRun: { type: 'boolean' }
      },
      required: ['path', 'edits']
    }
  },
  {
    name: 'create_directory',
    description: 'Create a directory (and parents if needed).',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  },
  {
    name: 'list_directory',
    description: 'List files and directories in a path.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  },
  {
    name: 'list_directory_with_sizes',
    description: 'List files and directories with file sizes.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, sortBy: { type: 'string', enum: ['name', 'size'] } }, required: ['path'] }
  },
  {
    name: 'directory_tree',
    description: 'Get a recursive tree view of files and directories (2 levels deep).',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  },
  {
    name: 'move_file',
    description: 'Move or rename a file or directory.',
    inputSchema: { type: 'object', properties: { source: { type: 'string' }, destination: { type: 'string' } }, required: ['source', 'destination'] }
  },
  {
    name: 'search_files',
    description: 'Recursively search for files matching a pattern.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        pattern: { type: 'string' },
        excludePatterns: { type: 'array', items: { type: 'string' } }
      },
      required: ['path', 'pattern']
    }
  },
  {
    name: 'get_file_info',
    description: 'Get metadata about a file or directory.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  },
  {
    name: 'list_allowed_directories',
    description: 'List all directories this server is allowed to access.',
    inputSchema: { type: 'object', properties: {} }
  },
];

async function callTool(name, args) {
  switch (name) {
    case 'read_file':
    case 'read_text_file': {
      const p = resolveSafe(args.path);
      let text = fs.readFileSync(p, 'utf8');
      if (args.head) text = text.split('\n').slice(0, args.head).join('\n');
      else if (args.tail) text = text.split('\n').slice(-args.tail).join('\n');
      return [{ type: 'text', text }];
    }

    case 'read_media_file': {
      const rawPath = args.path;
      const hashIdx = rawPath.lastIndexOf('#');
      const pageNum = hashIdx !== -1 ? parseInt(rawPath.slice(hashIdx + 1)) || 1 : 1;
      const cleanPath = hashIdx !== -1 ? rawPath.slice(0, hashIdx) : rawPath;
      const p = resolveSafe(cleanPath);
      const ext = path.extname(p).toLowerCase();
      if (ext === '.pdf') {
        const [totalPages, block] = await Promise.all([pdfPageCount(p), renderPdfPage(p, pageNum)]);
        return [block];
      }
      const data = fs.readFileSync(p).toString('base64');
      const mime = mimeType(ext);
      if (mime.startsWith('image/')) return [{ type: 'image', data, mimeType: mime }];
      if (mime.startsWith('audio/')) return [{ type: 'audio', data, mimeType: mime }];
      return [{ type: 'text', text: `Unsupported media type: ${mime}` }];
    }

    case 'read_pdf_page': {
      const p = resolveSafe(args.path);
      const n = parseInt(args.page) || 1;
      const total = await pdfPageCount(p);
      if (n < 1 || n > total) throw new Error(`Page ${n} out of range (1-${total})`);
      const block = await renderPdfPage(p, n);
      return [{ type: 'text', text: `Page ${n} of ${total}` }, block];
    }

    case 'read_multiple_files': {
      const results = [];
      for (const fp of args.paths) {
        try { results.push(`=== ${fp} ===\n${fs.readFileSync(resolveSafe(fp), 'utf8')}`); }
        catch (e) { results.push(`=== ${fp} ===\nERROR: ${e.message}`); }
      }
      return [{ type: 'text', text: results.join('\n\n') }];
    }

    case 'write_file': {
      const p = resolveSafe(args.path);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, args.content, 'utf8');
      return [{ type: 'text', text: `Written: ${p}` }];
    }

    case 'edit_file': {
      const p = resolveSafe(args.path);
      let text = fs.readFileSync(p, 'utf8');
      for (const edit of args.edits) {
        if (!text.includes(edit.oldText)) throw new Error(`oldText not found: "${edit.oldText.slice(0, 60)}"`);
        text = text.replace(edit.oldText, edit.newText);
      }
      if (!args.dryRun) fs.writeFileSync(p, text, 'utf8');
      return [{ type: 'text', text: `${args.dryRun ? '[DRY RUN] ' : ''}${args.edits.length} edit(s) applied to ${p}` }];
    }

    case 'create_directory': {
      const p = resolveSafe(args.path);
      fs.mkdirSync(p, { recursive: true });
      return [{ type: 'text', text: `Created: ${p}` }];
    }

    case 'list_directory':
      return [{ type: 'text', text: listDir(resolveSafe(args.path)) }];

    case 'list_directory_with_sizes':
      return [{ type: 'text', text: listDirWithSizes(resolveSafe(args.path), args.sortBy) }];

    case 'directory_tree':
      return [{ type: 'text', text: dirTree(resolveSafe(args.path)) }];

    case 'move_file': {
      const src = resolveSafe(args.source);
      const dst = resolveSafe(args.destination);
      fs.renameSync(src, dst);
      return [{ type: 'text', text: `Moved: ${src} → ${dst}` }];
    }

    case 'search_files': {
      const base = resolveSafe(args.path);
      const exclude = args.excludePatterns || [];
      const results = [];
      function walk(dir) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (exclude.some(ex => e.name.includes(ex))) continue;
          const full = path.join(dir, e.name);
          if (e.name.includes(args.pattern) || full.includes(args.pattern)) results.push(full);
          if (e.isDirectory()) walk(full);
        }
      }
      walk(base);
      return [{ type: 'text', text: results.join('\n') || 'No matches' }];
    }

    case 'get_file_info': {
      const p = resolveSafe(args.path);
      const s = fs.statSync(p);
      return [{ type: 'text', text: JSON.stringify({ path: p, size: s.size, isFile: s.isFile(), isDirectory: s.isDirectory(), created: s.birthtime, modified: s.mtime }, null, 2) }];
    }

    case 'list_allowed_directories':
      return [{ type: 'text', text: `Allowed directories:\n${ALLOWED_DIR}` }];

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function handleMcpRequest(body) {
  const { id, method, params } = body;

  if (method === 'initialize') {
    return { jsonrpc: '2.0', id, result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'vault-mcp-server', version: '2.0.0' }
    }};
  }

  if (method === 'notifications/initialized' || method === 'notifications/roots/list_changed') return null;
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  if (method === 'resources/list') return { jsonrpc: '2.0', id, result: { resources: [] } };
  if (method === 'prompts/list') return { jsonrpc: '2.0', id, result: { prompts: [] } };
  if (method === 'roots/list') return { jsonrpc: '2.0', id, result: { roots: [{ uri: `file://${ALLOWED_DIR}`, name: 'VAULT' }] } };

  if (method === 'tools/call') {
    try {
      const content = await callTool(params.name, params.arguments || {});
      return { jsonrpc: '2.0', id, result: { content, structuredContent: { content } } };
    } catch (e) {
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true } };
    }
  }

  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, mcp-session-id, mcp-protocol-version');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.url !== '/mcp') { res.writeHead(404); res.end('Not found'); return; }

  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write(': ping\n\n');
    return;
  }

  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }

  const accept = req.headers['accept'] || '';
  if (!accept.includes('application/json') && !accept.includes('text/event-stream')) {
    res.writeHead(406);
    res.end(JSON.stringify({ error: 'Not Acceptable: Client must accept both application/json and text/event-stream' }));
    return;
  }

  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', async () => {
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { res.writeHead(400); res.end('Bad JSON'); return; }

    const requests = Array.isArray(body) ? body : [body];
    const responses = [];
    for (const r of requests) {
      const resp = await handleMcpRequest(r);
      if (resp !== null) responses.push(resp);
    }

    const result = Array.isArray(body) ? responses : (responses[0] || null);
    if (result === null) { res.writeHead(202); res.end(); return; }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write(`event: message\ndata: ${JSON.stringify(result)}\n\n`);
    res.end();
  });
});

server.listen(PORT, () => {
  process.stderr.write(`Vault MCP Server v2.0 on port ${PORT}, allowed: ${ALLOWED_DIR}\n`);
});

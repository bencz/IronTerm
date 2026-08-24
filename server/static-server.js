import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';

const publicRoot = resolve(process.env.PUBLIC_DIR ?? 'public');
const port = Number.parseInt(process.env.PORT ?? '8080', 10);

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`Invalid PORT: ${process.env.PORT}`);
}

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.webp', 'image/webp'],
  ['.woff2', 'font/woff2']
]);

const securityHeaders = {
  'Content-Security-Policy': "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' ws: wss:",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY'
};

function respond (response, status, message, extraHeaders = {}) {
  response.writeHead(status, {
    ...securityHeaders,
    ...extraHeaders,
    'Content-Type': 'text/plain; charset=utf-8'
  });
  response.end(message);
}

async function serve (request, response) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    respond(response, 405, 'Method Not Allowed\n', { Allow: 'GET, HEAD' });
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  } catch {
    respond(response, 400, 'Bad Request\n');
    return;
  }

  let filePath = resolve(publicRoot, `.${pathname}`);
  if (filePath !== publicRoot && !filePath.startsWith(`${publicRoot}${sep}`)) {
    respond(response, 403, 'Forbidden\n');
    return;
  }

  try {
    let fileStat = await stat(filePath);
    if (fileStat.isDirectory()) {
      filePath = resolve(filePath, 'index.html');
      fileStat = await stat(filePath);
    }
    if (!fileStat.isFile()) throw new Error('Not a file');

    const extension = extname(filePath).toLowerCase();
    response.writeHead(200, {
      ...securityHeaders,
      'Cache-Control': extension === '.html' ? 'no-cache' : 'public, max-age=604800',
      'Content-Length': fileStat.size,
      'Content-Type': contentTypes.get(extension) ?? 'application/octet-stream'
    });

    if (request.method === 'HEAD') {
      response.end();
      return;
    }

    createReadStream(filePath).on('error', () => response.destroy()).pipe(response);
  } catch {
    respond(response, 404, 'Not Found\n');
  }
}

const server = createServer((request, response) => {
  serve(request, response).catch(() => respond(response, 500, 'Internal Server Error\n'));
});

server.listen(port, '0.0.0.0', () => {
  console.log(`IronTerm static server listening on port ${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

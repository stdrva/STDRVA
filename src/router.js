const { URL } = require('url');
const querystring = require('querystring');
const fs = require('fs');
const path = require('path');

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.csv': 'text/csv; charset=utf-8',
};

function matchPath(pattern, pathname) {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = pathname.split('/').filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;
  const params = {};
  for (let i = 0; i < patternParts.length; i++) {
    const p = patternParts[i];
    if (p.startsWith(':')) {
      params[p.slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (p !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 5 * 1024 * 1024) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// Same as readBody, but keeps raw bytes as a Buffer instead of coercing to a
// utf8 string - required for multipart/form-data, since string concatenation
// of binary chunks (images, PDFs) corrupts any byte that isn't valid utf8.
function readBodyBuffer(req, maxSize = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxSize) {
        reject(new Error('Upload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Minimal multipart/form-data parser (no external dependency). Returns
// { fields: {name: value}, files: [{fieldname, filename, mimeType, data: Buffer}] }.
function parseMultipart(buffer, boundary) {
  const boundaryBuf = Buffer.from(`--${boundary}`);
  const fields = {};
  const files = [];
  let start = buffer.indexOf(boundaryBuf);
  if (start === -1) return { fields, files };

  while (true) {
    const next = buffer.indexOf(boundaryBuf, start + boundaryBuf.length);
    if (next === -1) break;
    let part = buffer.slice(start + boundaryBuf.length, next);
    if (part.slice(0, 2).toString('latin1') === '\r\n') part = part.slice(2);
    const sep = part.indexOf('\r\n\r\n');
    if (sep !== -1) {
      const headerText = part.slice(0, sep).toString('utf8');
      let body = part.slice(sep + 4);
      if (body.slice(-2).toString('latin1') === '\r\n') body = body.slice(0, -2);
      const nameMatch = headerText.match(/name="([^"]*)"/i);
      const filenameMatch = headerText.match(/filename="([^"]*)"/i);
      const ctMatch = headerText.match(/Content-Type:\s*([^\r\n]+)/i);
      const name = nameMatch ? nameMatch[1] : null;
      if (name) {
        if (filenameMatch && filenameMatch[1]) {
          files.push({
            fieldname: name,
            filename: filenameMatch[1],
            mimeType: ctMatch ? ctMatch[1].trim() : 'application/octet-stream',
            data: body,
          });
        } else {
          fields[name] = body.toString('utf8');
        }
      }
    }
    start = next;
  }
  return { fields, files };
}

class Router {
  constructor() {
    this.routes = []; // { method, pattern, handlers: [fn...] }
    this.staticDirs = []; // { prefix, dir }
  }

  use(prefix, dir) {
    this.staticDirs.push({ prefix, dir });
  }

  _add(method, pattern, handlers) {
    this.routes.push({ method, pattern, handlers });
  }
  get(pattern, ...handlers) {
    this._add('GET', pattern, handlers);
  }
  post(pattern, ...handlers) {
    this._add('POST', pattern, handlers);
  }

  async handle(req, res) {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(u.pathname);

    // Static files
    for (const { prefix, dir } of this.staticDirs) {
      if (pathname.startsWith(prefix)) {
        const rel = pathname.slice(prefix.length);
        const filePath = path.join(dir, rel);
        if (!filePath.startsWith(dir)) continue; // path traversal guard
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          const ext = path.extname(filePath);
          res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
          fs.createReadStream(filePath).pipe(res);
          return;
        }
      }
    }

    req.query = Object.fromEntries(u.searchParams.entries());
    req.body = {};
    req.files = [];

    if (req.method === 'POST') {
      try {
        const ct = req.headers['content-type'] || '';
        if (ct.includes('multipart/form-data')) {
          const boundaryMatch = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
          const boundary = boundaryMatch ? (boundaryMatch[1] || boundaryMatch[2]).trim() : null;
          const raw = await readBodyBuffer(req);
          if (boundary) {
            const { fields, files } = parseMultipart(raw, boundary);
            req.body = fields;
            req.files = files;
          }
        } else {
          const raw = await readBody(req);
          if (ct.includes('application/json')) {
            req.body = raw ? JSON.parse(raw) : {};
          } else {
            req.body = querystring.parse(raw);
          }
        }
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad request body');
        return;
      }
    }

    for (const route of this.routes) {
      if (route.method !== req.method) continue;
      const params = matchPath(route.pattern, pathname);
      if (!params) continue;
      req.params = params;

      res.send = (html) => {
        res.writeHead(res.statusCode || 200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      };
      res.json = (obj) => {
        res.writeHead(res.statusCode || 200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(obj));
      };
      res.redirect = (loc) => {
        res.writeHead(302, { Location: loc });
        res.end();
      };
      res.status = (code) => {
        res.statusCode = code;
        return res;
      };
      res.sendCsv = (filename, content) => {
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`,
        });
        res.end(content);
      };

      try {
        let idx = 0;
        const next = async () => {
          const h = route.handlers[idx++];
          if (!h) return;
          await h(req, res, next);
        };
        await next();
      } catch (err) {
        console.error('Route error:', err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal server error');
        }
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

module.exports = { Router };

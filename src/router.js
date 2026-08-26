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

    if (req.method === 'POST') {
      try {
        const raw = await readBody(req);
        const ct = req.headers['content-type'] || '';
        if (ct.includes('application/json')) {
          req.body = raw ? JSON.parse(raw) : {};
        } else {
          req.body = querystring.parse(raw);
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

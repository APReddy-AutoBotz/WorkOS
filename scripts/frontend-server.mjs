import {isIP} from 'node:net';
import express from 'express';
import {createProxyServer} from 'httpxy';

export function createFrontendApp(hostnameToAllow, apiUrl) {
  const proxy = createProxyServer({target: apiUrl, changeOrigin: true});
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const host = req.headers.host?.match(/^(?:\[([a-f\d:]+)\]|([\w.-]+))(?::\d+)?$/i);
    const hostname = (host?.[1] || host?.[2] || '').toLowerCase();
    if (!isIP(hostname) && hostname !== 'localhost' && !hostname.endsWith('.localhost') &&
        hostname !== hostnameToAllow.toLowerCase()) return res.sendStatus(403);
    next();
  });
  app.all(['/api', '/api/*'], (req, res) => {
    proxy.web(req, res).catch(() => {
      if (res.headersSent) res.destroy();
      else res.sendStatus(502);
    });
  });
  return app;
}

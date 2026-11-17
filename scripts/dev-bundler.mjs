import entry from './dev-entry.html' with {type: 'html'};

// The public listener handles host validation, public assets, HTML and the API.
// Bind Bun's compiler to loopback and give its address only to that listener.
const server = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  development: {hmr: process.env.DISABLE_HMR !== 'true', console: false, chromeDevToolsAutomaticWorkspaceFolders: false},
  routes: {'/': entry},
});
process.on('disconnect', () => { server.stop(true); process.exit(0); });
process.send({port: server.port});

// Module: Heroku deployment prep. These checks never touch any real
// database — GET /api/health and the trust-proxy/CORS/SPA-fallback
// behaviour below don't query it, so this file runs unconditionally
// (unlike permissions.matrix.test.js, it needs no TEST_DATABASE_URL).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const { app: devApp } = require('../app');

// trust proxy, CORS's allowed-origin rule and the DB SSL option are all
// decided once, at module-load time, from NODE_ENV — so testing the
// production branch means loading a second, independent copy of the
// module with NODE_ENV temporarily set, rather than mutating the one
// instance every other test file in this process might also be using.
function requireFreshApp(nodeEnv) {
  const appPath = require.resolve('../app');
  delete require.cache[appPath];
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = nodeEnv;
  try {
    return require('../app');
  } finally {
    process.env.NODE_ENV = previousNodeEnv;
  }
}

test('GET /api/health is public and reports status + version', async () => {
  const server = devApp.listen(0);
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/api/health`);
    assert.strictEqual(response.status, 200);
    const body = await response.json();
    assert.strictEqual(body.status, 'ok');
    assert.strictEqual(typeof body.version, 'string');
    assert.ok(body.version.length > 0);
  } finally {
    server.close();
  }
});

test('trust proxy is off outside production', () => {
  assert.strictEqual(devApp.get('trust proxy'), false);
});

test('trust proxy is set to 1 in production (for req.ip behind Heroku\'s router)', () => {
  const { app: prodApp } = requireFreshApp('production');
  assert.strictEqual(prodApp.get('trust proxy'), 1);
});

test('CORS: dev reflects the request origin; production disables cross-origin entirely', async () => {
  const { app: prodApp } = requireFreshApp('production');

  const devServer = devApp.listen(0);
  const prodServer = prodApp.listen(0);
  try {
    const devBaseUrl = `http://127.0.0.1:${devServer.address().port}`;
    const prodBaseUrl = `http://127.0.0.1:${prodServer.address().port}`;

    const devResponse = await fetch(`${devBaseUrl}/api/health`, {
      headers: { Origin: 'https://example.com' },
    });
    assert.strictEqual(devResponse.headers.get('access-control-allow-origin'), 'https://example.com');

    const prodResponse = await fetch(`${prodBaseUrl}/api/health`, {
      headers: { Origin: 'https://example.com' },
    });
    assert.strictEqual(prodResponse.headers.get('access-control-allow-origin'), null);
  } finally {
    devServer.close();
    prodServer.close();
  }
});

test('SPA fallback serves index.html for non-/api routes, and unknown /api/* paths still get a JSON 404', async () => {
  // app.js only registers the static/SPA-fallback middleware when
  // frontend/build/index.html exists on disk at require-time — this
  // test stubs that file directly rather than depending on a real
  // `npm run build` having been run, and restores whatever was there
  // (nothing, usually) afterwards.
  const realBuildDir = path.join(__dirname, '..', '..', 'frontend', 'build');
  const indexHtmlPath = path.join(realBuildDir, 'index.html');
  const buildDirExisted = fs.existsSync(realBuildDir);
  const indexHtmlExisted = fs.existsSync(indexHtmlPath);
  const originalIndexHtml = indexHtmlExisted ? fs.readFileSync(indexHtmlPath, 'utf8') : null;

  fs.mkdirSync(realBuildDir, { recursive: true });
  const marker = `SPA-FALLBACK-TEST-${Date.now()}`;
  fs.writeFileSync(indexHtmlPath, `<!doctype html><html><body>${marker}</body></html>`);

  try {
    const { app: prodApp } = requireFreshApp('production');
    const server = prodApp.listen(0);
    try {
      const baseUrl = `http://127.0.0.1:${server.address().port}`;

      const unknownApiResponse = await fetch(`${baseUrl}/api/this-route-does-not-exist`);
      assert.strictEqual(unknownApiResponse.status, 404);
      const unknownApiBody = await unknownApiResponse.json();
      assert.strictEqual(unknownApiBody.error, 'Not found.');

      const spaResponse = await fetch(`${baseUrl}/demand-by-district`);
      assert.strictEqual(spaResponse.status, 200);
      const spaBody = await spaResponse.text();
      assert.ok(spaBody.includes(marker), 'expected the SPA fallback to serve frontend/build/index.html');
    } finally {
      server.close();
    }
  } finally {
    if (indexHtmlExisted) {
      fs.writeFileSync(indexHtmlPath, originalIndexHtml);
    } else if (buildDirExisted) {
      fs.rmSync(indexHtmlPath, { force: true });
    } else {
      fs.rmSync(realBuildDir, { recursive: true, force: true });
    }
  }
});

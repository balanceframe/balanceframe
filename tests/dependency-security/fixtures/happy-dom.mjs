import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const { Browser } = await import(pathToFileURL(process.argv[2]));
const scenario = process.argv[3];
// Evaluation/loading is enabled only in the owned, synthetic fixture that needs it.
const settings = scenario.endsWith('module') || scenario === 'import-binding'
  ? { enableJavaScriptEvaluation: true, disableErrorCapturing: true }
  : undefined;
const browser = new Browser({ settings });
// Happy DOM 20 loads these by default; 21 requires a fixture-local opt-in.
if (scenario.endsWith('iframe') && 'enableIframePageLoading' in browser.settings) {
  browser.settings.enableIframePageLoading = true;
}
const page = browser.newPage();
page.mainFrame.url = 'https://fixture.invalid/';
let server;

try {
  if (scenario === 'import-binding') {
    await page.mainFrame.evaluateModule({
      url: '/main.js',
      code: 'import { missing as injected = globalThis.bindingMarker = 1337 } from "data:application/json,%7B%7D" with { type: "json" };',
    });
    assert.equal(page.mainFrame.window.bindingMarker, undefined, 'invalid import binding must not become an executable initializer');
  } else if (scenario === 'ordinary-module') {
    const exports = await page.mainFrame.evaluateModule({
      url: '/main.js',
      code: 'import { default as fixture } from "data:application/json,%7B%22value%22%3A42%7D" with { type: "json" }; export const value = fixture.value;',
    });
    assert.equal(exports.value, 42);
  } else if (scenario === 'default-resources') {
    const requests = [];
    server = createServer((request, response) => {
      requests.push(request.url);
      response.setHeader('Content-Type', request.url === '/style.css' ? 'text/css' : 'text/html');
      response.end(request.url === '/style.css' ? 'body { color: red; }' : '<p>owned fixture</p>');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    page.mainFrame.url = origin;
    page.content = `<link rel="stylesheet" href="${origin}/style.css"><iframe src="${origin}/frame"></iframe><script>globalThis.scriptMarker = 1;</script><p id="control">ordinary DOM</p>`;
    await page.waitUntilComplete();
    assert.deepEqual(requests, [], 'default parsing must not fetch stylesheets or iframe pages');
    assert.equal(page.mainFrame.window.scriptMarker, undefined, 'JavaScript remains disabled by default');
    assert.equal(page.mainFrame.document.querySelector('#control').textContent, 'ordinary DOM');
    assert.equal(page.mainFrame.document.querySelector('link').sheet, null);
  } else if (scenario === 'opaque-iframe' || scenario === 'inherited-iframe') {
    page.content = '<p id="parent">parent fixture</p><iframe></iframe>';
    const iframe = page.mainFrame.document.querySelector('iframe');
    iframe.src = scenario === 'opaque-iframe' ? 'data:text/html,%3Cp%3Echild%20fixture%3C%2Fp%3E' : 'about:blank';
    await page.waitUntilComplete();
    assert.equal(page.mainFrame.childFrames.length, 1, 'fixture iframe actually loads');
    const child = page.mainFrame.childFrames[0].window;
    if (scenario === 'opaque-iframe') {
      assert.equal(child.location.origin, 'null');
      assert.equal(child.document.body.textContent, 'child fixture');
      for (const relation of ['parent', 'top']) {
        assert.equal(typeof child[relation].document, 'undefined', `${relation} document must be inaccessible`);
        // Upstream 21.0.4 recurses while formatting this denied-access error.
        assert.throws(() => child[relation].location.href, { name: 'RangeError' });
      }
      assert.equal(iframe.contentWindow.document, undefined);
      assert.throws(() => iframe.contentWindow.location.href, { name: 'SecurityError' });
    } else {
      assert.equal(child.parent.document.querySelector('#parent').textContent, 'parent fixture');
      assert.equal(child.top.document, page.mainFrame.document);
      assert.equal(iframe.contentWindow.document, child.document);
    }
  } else {
    throw new Error(`Unknown fixture: ${scenario}`);
  }
  console.log(`${scenario}: passed`);
} finally {
  await browser.close();
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

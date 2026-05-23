import test from "node:test";
import assert from "node:assert/strict";
import { extractDocument } from "../src/extract.js";

test("extractDocument returns sanitized semantic HTML, markdown, and text", async () => {
  const html = `
    <html><head><title>Fixture Doc</title><script>bad()</script></head>
    <body>
      <nav>skip me</nav>
      <article class="x" onclick="bad()">
        <h1 data-x="gone">Fixture Doc</h1>
        <p>Use <code>node:sqlite</code> with <a href="/docs">docs</a>.</p>
        <iframe src="https://evil.example"></iframe>
        <table class="grid"><tr><th scope="col">API</th><td>bm25</td></tr></table>
      </article>
    </body></html>`;
  const result = await extractDocument(html, "https://example.com/root/page", "page1");
  assert.match(result.semanticHtml, /<article data-source-id="page1">/);
  assert.match(result.semanticHtml, /href="https:\/\/example.com\/docs"/);
  assert.doesNotMatch(result.semanticHtml, /script|iframe|onclick|class=|data-x/);
  assert.match(result.semanticHtml, /<table>/);
  assert.match(result.markdown, /node:sqlite/);
  assert.match(result.text, /bm25/);
});

test("extractDocument strips unsafe href/src protocols and preserves http(s)", async () => {
  const html = `
    <article>
      <h1>Links</h1>
      <p>
        <a href="javascript:alert(1)">js</a>
        <a href="data:text/html,bad">data</a>
        <a href="file:///etc/passwd">file</a>
        <a href="/safe">relative</a>
        <img src="https://cdn.example/image.png" alt="ok">
      </p>
    </article>`;
  const result = await extractDocument(html, "https://example.com/base/page", "page1");
  assert.doesNotMatch(result.semanticHtml, /javascript:|data:text|file:\/\/\//);
  assert.match(result.semanticHtml, /href="https:\/\/example.com\/safe"/);
  assert.match(result.semanticHtml, /src="https:\/\/cdn.example\/image.png"/);
});

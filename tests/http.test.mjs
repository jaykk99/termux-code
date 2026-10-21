/**
 * Tests for lib/http.mjs — the gateway's shared HTTP helpers.
 * Run: node --test tests/
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bad, badMessage, readJSON, logRequest, upstreamError } from '../lib/http.mjs';

function fakeReq(url = 'https://x.test/api/chat', method = 'POST') {
  return { url, method, body: null };
}

function bodyReq(chunks) {
  // Minimal ReadableStream-like body with a getReader().
  let i = 0;
  return {
    url: 'https://x.test/api/chat',
    method: 'POST',
    body: {
      getReader() {
        return {
          async read() {
            if (i >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: chunks[i++] };
          },
        };
      },
    },
  };
}

describe('bad()', () => {
  it('returns structured JSON errors with the mapped status', async () => {
    const res = bad('NO_KEY', 'missing key');
    assert.equal(res.status, 401);
    const json = await res.json();
    assert.equal(json.ok, false);
    assert.equal(json.error.code, 'NO_KEY');
    assert.equal(json.error.message, 'missing key');
  });

  it('lets the caller override the status', async () => {
    const res = bad('INTERNAL', 'boom', 418);
    assert.equal(res.status, 418);
  });

  it('defaults unknown codes to 500', async () => {
    const res = bad('SOMETHING_ELSE', 'x');
    assert.equal(res.status, 500);
  });
});

describe('badMessage()', () => {
  it('keeps the legacy {ok:false, error:{code,message}} shape', async () => {
    const res = badMessage('nope');
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.error.code, 'BAD_REQUEST');
    assert.equal(json.error.message, 'nope');
  });
});

describe('readJSON()', () => {
  it('parses chunked JSON bodies', async () => {
    const req = bodyReq([Buffer.from('{"a":'), Buffer.from('1}')]);
    assert.deepEqual(await readJSON(req), { a: 1 });
  });

  it('throws 413 when the body exceeds maxBytes', async () => {
    const req = bodyReq([Buffer.from('x'.repeat(100))]);
    try {
      await readJSON(req, { maxBytes: 10 });
      assert.fail('should have thrown');
    } catch (err) {
      assert.equal(err.status, 413);
      const json = await err.json();
      assert.equal(json.error.code, 'MESSAGE_TOO_LONG');
    }
  });

  it('throws 400 on invalid JSON', async () => {
    const req = bodyReq([Buffer.from('not json{')]);
    try {
      await readJSON(req);
      assert.fail('should have thrown');
    } catch (err) {
      assert.equal(err.status, 400);
    }
  });

  it('throws 400 when there is no body at all', async () => {
    try {
      await readJSON(fakeReq());
      assert.fail('should have thrown');
    } catch (err) {
      assert.equal(err.status, 400);
    }
  });
});

describe('upstreamError()', () => {
  it('maps timeouts to 504 TIMEOUT', async () => {
    const res = upstreamError(new Error('Upstream timed out after 45s (https://x)'));
    assert.equal(res.status, 504);
    const json = await res.json();
    assert.equal(json.error.code, 'TIMEOUT');
  });

  it('maps other failures to 502 UPSTREAM without leaking long bodies', async () => {
    const res = upstreamError(new Error('x'.repeat(2000)));
    assert.equal(res.status, 502);
    const json = await res.json();
    assert.equal(json.error.code, 'UPSTREAM');
    assert.ok(json.error.message.length <= 500);
  });

  it('handles non-Error throws', async () => {
    const res = upstreamError(null);
    assert.equal(res.status, 502);
  });
});

describe('logRequest()', () => {
  it('logs one line per request without throwing', () => {
    const lines = [];
    const orig = console.log;
    const origErr = console.error;
    console.log = (l) => lines.push(l);
    console.error = (l) => lines.push(l);
    try {
      logRequest(fakeReq('https://x.test/api/chat', 'GET'), 200, 12.4);
      logRequest(fakeReq('https://x.test/api/chat', 'POST'), 500, 3.1, 'extra');
    } finally {
      console.log = orig;
      console.error = origErr;
    }
    assert.match(lines[0], /GET \/api\/chat -> 200 12ms/);
    assert.match(lines[1], /POST \/api\/chat -> 500 3ms extra/);
  });
});

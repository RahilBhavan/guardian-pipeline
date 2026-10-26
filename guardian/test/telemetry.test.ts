import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startTelemetry, traced } from '../src/telemetry.js';

test('forced error exports an OTLP span without credential-bearing error text', async () => {
  let received = '';
  const server = createServer(async (req, res) => {
    assert.equal(req.url, '/v1/traces');
    for await (const chunk of req) received += chunk.toString();
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = `http://127.0.0.1:${address.port}/v1/traces`;
  const telemetry = startTelemetry();
  try {
    await assert.rejects(traced('guardian.forced_error', { 'guardian.block': '123' }, async () => {
      throw new Error('https://rpc.example/private-secret');
    }));
    await telemetry.shutdown();
    const payload = JSON.parse(received);
    assert.match(received, /guardian.forced_error/);
    assert.match(received, /GuardianOperationError/);
    assert.ok(!received.includes('private-secret'));
    assert.equal(payload.resourceSpans[0].scopeSpans[0].spans[0].status.code, 2);
  } finally { delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT; server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

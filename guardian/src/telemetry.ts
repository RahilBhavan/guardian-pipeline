import { SpanStatusCode, trace, type Attributes } from '@opentelemetry/api';
import { NodeTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';

/** Opt-in OTLP/HTTP export. No RPC URLs, keys, raw errors or user positions in spans. */
export function startTelemetry(): { shutdown: () => Promise<void> } {
  if (!process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT && !process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    return { shutdown: async () => {} };
  }
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ 'service.name': process.env.OTEL_SERVICE_NAME ?? 'guardian' }),
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ timeoutMillis: 3000 }))],
  });
  provider.register();
  return { shutdown: () => provider.shutdown() };
}

export function recordError(operation: string): void {
  const span = trace.getTracer('guardian').startSpan(operation);
  // Provider errors can contain credential-bearing request URLs. Export a
  // category only; the existing server-side logger retains local diagnostics.
  span.recordException({ name: 'GuardianOperationError', message: operation });
  span.setStatus({ code: SpanStatusCode.ERROR, message: operation });
  span.end();
}

export async function traced<T>(operation: string, attributes: Attributes, work: () => Promise<T>): Promise<T> {
  return trace.getTracer('guardian').startActiveSpan(operation, { attributes }, async (span) => {
    try { return await work(); }
    catch (err) {
      span.recordException({ name: 'GuardianOperationError', message: operation });
      span.setStatus({ code: SpanStatusCode.ERROR, message: operation });
      throw err;
    } finally { span.end(); }
  });
}

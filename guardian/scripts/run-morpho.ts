import { morphoInputs } from './morpho-config.js';
import { detectMorpho, morphoJson } from '../src/morpho.js';
try {
  const { params } = await morphoInputs();
  const report = await detectMorpho(params);
  console.log(JSON.stringify(report, morphoJson, 2));
  if (report.results.violations.length) process.exitCode = 2;
} catch {
  // RPC exception text may contain an authenticated URL.
  console.error('Morpho detection failed; check RPC, fixture and archive availability');
  process.exitCode = 1;
}

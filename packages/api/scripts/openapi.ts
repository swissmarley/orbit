import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildOpenApi } from '../src/openapi';

// Regenerates packages/api/openapi.json (checked in; a test keeps it current).
const out = join(import.meta.dirname, '..', 'openapi.json');
writeFileSync(out, `${JSON.stringify(buildOpenApi(), null, 2)}\n`);
process.stdout.write(`wrote ${out}\n`);

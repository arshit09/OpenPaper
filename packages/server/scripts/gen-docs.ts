// Generate docs/mcp-tools.md from the live tool definitions: `npx tsx packages/server/scripts/gen-docs.ts`
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mcpToolList, TOOL_DEFINITIONS } from '../src/tools/definitions.ts';
import { SERVER_INSTRUCTIONS } from '../src/tools/guides.ts';

type Schema = { type?: string; description?: string; enum?: string[]; anyOf?: Schema[]; items?: Schema; properties?: Record<string, Schema>; required?: string[]; const?: string; additionalProperties?: Schema | boolean; minimum?: number; maximum?: number; default?: unknown };

function typeOf(s: Schema | undefined): string {
  if (!s) return 'any';
  if (s.const !== undefined) return `"${s.const}"`;
  if (s.enum) return s.enum.map((e) => `"${e}"`).join(' \\| ');
  if (s.anyOf) return s.anyOf.map(typeOf).join(' \\| ');
  if (s.type === 'array') return `${typeOf(s.items)}[]`;
  if (s.type === 'object' && s.properties) {
    const req = new Set(s.required ?? []);
    return `{ ${Object.entries(s.properties)
      .map(([k, v]) => `${k}${req.has(k) ? '' : '?'}: ${typeOf(v)}`)
      .join(', ')} }`;
  }
  if (s.type === 'object' && s.additionalProperties && typeof s.additionalProperties === 'object') return `Record<string, ${typeOf(s.additionalProperties)}>`;
  return s.type ?? 'any';
}

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const tools = mcpToolList();
let md = `# OpenPaper MCP tools

OpenPaper exposes ${tools.length} tools, compatible with Paper's MCP server (same names, parameters and response shapes).
Generated from \`packages/server/src/tools/definitions.ts\` — do not edit by hand.

- **Streamable HTTP:** \`http://127.0.0.1:29880/mcp\` (while OpenPaper is running)
- **stdio:** \`openpaper mcp\` (starts OpenPaper in the background when needed)

Every file-scoped tool returns a first text item \`{"file":{"id","name"},"contentHash":{"tokens"}}\` followed by the result.

## Server instructions

\`\`\`text
${SERVER_INSTRUCTIONS}
\`\`\`

`;

for (const def of TOOL_DEFINITIONS) {
  const tool = tools.find((t) => t.name === def.name)!;
  const schema = tool.inputSchema as Schema;
  const req = new Set(schema.required ?? []);
  const hints = Object.entries(def.annotations)
    .filter(([, v]) => v)
    .map(([k]) => k.replace(/Hint$/, ''))
    .join(', ');
  md += `## \`${def.name}\`\n\n_${def.scope === 'app' ? 'App-level' : def.scope === 'file' ? 'File-scoped' : 'File-scoped (fileId optional)'}${hints ? ` · ${hints}` : ''}_\n\n${def.description}\n\n`;
  const props = Object.entries(schema.properties ?? {});
  if (props.length) {
    md += '| Parameter | Type | Required | Description |\n|---|---|---|---|\n';
    for (const [name, p] of props) {
      const desc = (p.description ?? '').replace(/\n/g, ' ').replace(/\|/g, '\\|');
      md += `| \`${name}\` | ${typeOf(p).replace(/\|(?! )/g, '\\|')} | ${req.has(name) ? 'yes' : ''} | ${desc} |\n`;
    }
    md += '\n';
  }
}

writeFileSync(join(root, 'docs/mcp-tools.md'), md);
console.log(`wrote docs/mcp-tools.md (${tools.length} tools)`);

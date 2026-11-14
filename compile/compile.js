// compileWorld: turn a plain-English description into a validated world spec with Claude (docs/PROTOTYPE.md §10).
// Claude submits the world through the submit_world tool (input_schema = worlds/schema.json); validateWorld
// checks it and any errors go back as the tool result until the world is valid or attempts run out.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { validateWorld } from '../engine/spec.js';

const WORLDS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'worlds');

export const DEFAULT_MODEL = 'claude-opus-5-5';
const MAX_TOKENS = 32000;
const TOOL_NAME = 'submit_world';
// Server-side refusal fallback: on a policy decline the API retries on its default fallback model.
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export const NO_KEY_MESSAGE =
  'swarm compile needs ANTHROPIC_API_KEY (put ANTHROPIC_API_KEY=... in .env.local). ' +
  'Without a key, use Claude Code instead: open this repo in Claude Code and run ' +
  '/swarm <a place and a question>. Claude Code reads worlds/SCHEMA.md, writes worlds/<slug>.json, ' +
  'checks it with `node bin/swarm.js validate`, then runs and reports on it. ' +
  'You can also write the world JSON by hand following worlds/SCHEMA.md.';

const SYSTEM_PREAMBLE = `You turn a plain-English description of a place and a question into a Swarmscope world: a JSON spec that a simulator runs with hundreds or thousands of agents, each making its own decisions.

Submit the world by calling the ${TOOL_NAME} tool once, with the complete world as its input. Do not put the world in a text reply.

How to build it:
- Follow the world format reference below exactly and use only the fields it defines. Give every node and archetype an explicit id and reference them by id.
- Pick the mode that fits: visit when people choose among places with lines; route when people move through shared links (roads, or corridors, doors, turnstiles, escalators and elevators inside a building).
- Use plausible, concrete numbers for capacities, service times, lengths and arrival patterns. Size arrivals so that peak demand is near or above capacity somewhere; otherwise there is nothing to rank. Keep arrivals.total between 300 and 3000 unless the description clearly needs more, because every agent decision costs money.
- Write a one- or two-sentence context for the agents, a question that asks for a ranking, 2-4 archetypes, and a cast of 10-20 invented people that covers every archetype. Give each person a concrete situation (bio), personality, goal, who they listen to (social) and whether they have the live app (informed), plus entry, origin or destination where it matters.
- Give each service an about text agents can react to, consistent with its appeal.
- Never use the names of real private individuals. Name real public places only if the description names them.
- If the tool result reports validation errors, fix every one and call ${TOOL_NAME} again with the whole corrected world.`;

function loadReference() {
  return {
    schemaMd: readFileSync(join(WORLDS_DIR, 'SCHEMA.md'), 'utf8'),
    schema: JSON.parse(readFileSync(join(WORLDS_DIR, 'schema.json'), 'utf8'))
  };
}

// After a mid-stream fallback, blocks the declined model wrote before the `fallback` block must not be
// echoed back, except text; the `fallback` block itself stays where it appeared.
function echoable(content) {
  const boundary = content.findLastIndex(b => b.type === 'fallback');
  if (boundary < 0) return content;
  return content.filter((b, i) => i >= boundary || b.type === 'text');
}

function feedbackText(result) {
  const lines = ['The world did not validate. Fix every error below and call submit_world again with the complete corrected world.', '', 'Errors:'];
  for (const e of result.errors.slice(0, 40)) lines.push(`- ${e}`);
  if (result.warnings.length) {
    lines.push('', 'Warnings (fix any you did not intend):');
    for (const w of result.warnings.slice(0, 20)) lines.push(`- ${w}`);
  }
  return lines.join('\n');
}

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Compile a description into a valid world.
 * @param {string} description  a place, the people in it and the question
 * @param {{ apiKey?: string, model?: string, maxAttempts?: number, client?: object }} opts
 *   `client` is an Anthropic client (injected in tests); without one, `apiKey` (default ANTHROPIC_API_KEY) is required.
 * @returns {Promise<{ spec: object, attempts: number, warnings: string[] }>} `spec` is the world as Claude wrote it.
 */
export async function compileWorld(description, {
  apiKey = process.env.ANTHROPIC_API_KEY, model = DEFAULT_MODEL, maxAttempts = 3, client = null
} = {}) {
  const text = String(description ?? '').trim();
  if (!text) throw new Error('Describe a place, the people in it and the question to answer.');
  if (!client) {
    if (typeof apiKey !== 'string' || !apiKey.trim()) {
      throw Object.assign(new Error(NO_KEY_MESSAGE), { code: 'NO_ANTHROPIC_KEY' });
    }
    client = new Anthropic({ apiKey });
  }

  const { schemaMd, schema } = loadReference();
  const params = {
    model,
    max_tokens: MAX_TOKENS,
    betas: [FALLBACK_BETA],
    fallbacks: 'default',
    output_config: { effort: 'high' },
    cache_control: { type: 'ephemeral' },
    system: `${SYSTEM_PREAMBLE}\n\n<world_format_reference>\n${schemaMd}\n</world_format_reference>`,
    tools: [{
      name: TOOL_NAME,
      description: 'Submit the complete Swarmscope world. The input must follow the world format reference. ' +
        'The simulator validates it and returns any errors to fix.',
      input_schema: schema,
      eager_input_streaming: true
    }],
    // This model rejects forced tool_choice, so the prompt asks for the call and the loop checks it was made.
    tool_choice: { type: 'auto', disable_parallel_tool_use: true }
  };
  const messages = [{
    role: 'user',
    content: `Build a Swarmscope world for this description, then submit it with ${TOOL_NAME}.\n\n<description>\n${text}\n</description>`
  }];

  let problems = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let message;
    try {
      message = await client.beta.messages.stream({ ...params, messages }).finalMessage();
    } catch (err) {
      // With eager input streaming the SDK rejects when a tool input is not parseable JSON at all.
      // That attempt is retried as is; API errors (auth, rate limits, bad requests) propagate.
      if (err instanceof Anthropic.APIError) throw err;
      problems = [`the submitted world was not parseable JSON (${err?.message ?? err})`];
      continue;
    }
    if (message.stop_reason === 'refusal') {
      const why = message.stop_details?.explanation;
      throw new Error(`Claude declined to build this world${why ? `: ${why}` : ''}. Try rephrasing the description.`);
    }

    const content = echoable(message.content);
    messages.push({ role: 'assistant', content });
    const call = content.find(b => b.type === 'tool_use' && b.name === TOOL_NAME);
    if (!call) {
      problems = ['Claude did not call submit_world'];
      messages.push({ role: 'user', content: `Call the ${TOOL_NAME} tool with the complete world. Do not reply with text.` });
      continue;
    }

    const answer = feedback => messages.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: call.id, is_error: true, content: feedback }]
    });
    if (message.stop_reason === 'max_tokens') {
      problems = ['the submitted world was cut off at the output limit'];
      answer('Your submission was cut off at the output limit. Call submit_world again with a more compact world: shorter about and bio texts and at most 14 cast members.');
      continue;
    }
    if (!isPlainObject(call.input)) {
      problems = ['the submitted world was not a JSON object'];
      answer(JSON.stringify({ INVALID_JSON: JSON.stringify(call.input) }));
      continue;
    }

    const result = validateWorld(call.input);
    if (result.ok) return { spec: call.input, attempts: attempt, warnings: result.warnings };
    problems = result.errors;
    answer(feedbackText(result));
  }

  const listed = problems.slice(0, 8).map(p => `- ${p}`).join('\n');
  throw Object.assign(
    new Error(`Could not compile a valid world in ${maxAttempts} attempt${maxAttempts === 1 ? '' : 's'}. Last problems:\n${listed}`),
    { code: 'COMPILE_FAILED', errors: problems }
  );
}

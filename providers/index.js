// makeProvider(name, opts): the single place that turns a provider name into an instance
// (docs/PROTOTYPE.md §6). Callers run loadEnv() from engine/env.js first so TYPESAFE_API_KEY
// from .env.local is visible in process.env.
import { RulesProvider } from './rules.js';
import { JevProvider, JevAuthError } from './jev.js';
import { ReplayProvider } from './replay.js';

export { RulesProvider, JevProvider, JevAuthError, ReplayProvider };

export const PROVIDER_NAMES = ['rules', 'rules-external', 'jev', 'replay'];

export function makeProvider(name, opts = {}) {
  switch (name) {
    case 'rules':
      return new RulesProvider();
    case 'rules-external':
      return new RulesProvider({ external: true });
    case 'jev': {
      const apiKey = opts.apiKey ?? process.env.TYPESAFE_API_KEY;
      if (typeof apiKey !== 'string' || !apiKey.trim()) {
        throw new Error(
          'TYPESAFE_API_KEY is not set, so the Jev provider cannot run. Put TYPESAFE_API_KEY=... in .env.local ' +
          '(see .env.example) or export it in your shell, or use --provider rules.'
        );
      }
      return new JevProvider({ ...opts, apiKey });
    }
    case 'replay':
      if (!opts.runDir) throw new Error('The replay provider needs opts.runDir (a recorded run directory, e.g. --from runs/<runId>).');
      return new ReplayProvider(opts);
    default:
      throw new Error(`Unknown provider "${name}". Use one of: ${PROVIDER_NAMES.join(', ')}.`);
  }
}

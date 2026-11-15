#!/usr/bin/env node
// Both local entrypoints serve the same application and API. A static-only preview used to
// show new frontend files without the environment endpoints needed to build and run them.
import { loadEnv } from '../engine/env.js';
import { startServer } from '../server/server.js';

loadEnv();
const port = process.env.PORT === undefined ? 4174 : Number(process.env.PORT);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer from 0 to 65535.');
const app = await startServer({ port, root: process.cwd(), rootRedirect: '/scope/' });
console.log(`Scope display: ${app.url}/scope/`);
console.log(`Custom environments: ${app.url}/scope/?mode=environment`);
const stop = async () => { await app.close(); };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

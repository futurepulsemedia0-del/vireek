#!/usr/bin/env node
import { main } from '../dist/cli.js';

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
// Piping into `head` & co. closes stdout early; that is not an error.
process.stdout.on('error', (error) => {
  if (error.code === 'EPIPE') process.exit(0);
  throw error;
});

process.exitCode = await main(process.argv.slice(2), { signal: controller.signal });

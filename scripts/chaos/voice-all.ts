// Runs every voice chaos scenario. Exit code 1 on any failed check.
//   node --experimental-strip-types --no-warnings scripts/chaos/voice-all.ts
import { printResults } from "./lib/harness.ts";
import { run as webhook } from "./voice-webhook-chaos.ts";
import { run as provider } from "./voice-provider-5xx.ts";
import { run as llm } from "./voice-llm-tts-timeout.ts";
import { run as twilio } from "./voice-twilio-failure.ts";

const results = [await provider(), await webhook(), await llm(), await twilio()];
process.exit(printResults(results) ? 0 : 1);

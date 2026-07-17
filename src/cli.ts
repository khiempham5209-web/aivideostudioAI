#!/usr/bin/env node
import { config } from "dotenv";
config({ path: ".env.local" });

import { runTemplatePipeline } from "./render/template-pipeline.js";
import { log } from "./utils/logger.js";

async function main() {
  const scriptPath = process.argv[2];
  if (!scriptPath) {
    console.error("Usage: npm run pipeline -- <path/to/script.json>");
    process.exit(2);
  }
  try {
    // Single pipeline: vendored HyperFrames templates (renderer "hyperframes").
    await runTemplatePipeline(scriptPath);
  } catch (e) {
    log.error("Pipeline failed", e);
    process.exit(1);
  }
}

main();

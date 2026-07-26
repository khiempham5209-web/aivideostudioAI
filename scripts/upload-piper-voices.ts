// One-off/rerunnable admin script: uploads every local Piper voice model
// (.onnx + .onnx.json) from .piper-voices/ to R2 under "piper-voices/" so a
// fresh install can download them lazily via /api/voices/piper-asset instead
// of bundling ~2GB of model weights into the installer itself.
import dotenv from "dotenv";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { uploadFileToR2, isR2Configured } from "../src/cloud/r2-storage.js";
import { VOICE_OPTIONS } from "../src/tts/voice-catalog.js";

dotenv.config({ path: ".env.local" });

if (!isR2Configured()) {
  console.error("R2 is not configured (check .env.local) — aborting.");
  process.exit(1);
}

const dir = ".piper-voices";
const knownNames = new Set(VOICE_OPTIONS.filter((v) => v.provider === "piper").map((v) => v.name));
const files = readdirSync(dir).filter((f) => {
  const base = f.replace(/\.onnx(\.json)?$/, "");
  return knownNames.has(base);
});

console.log(`Uploading ${files.length} files to r2://piper-voices/...`);
let uploaded = 0;
for (const file of files) {
  const contentType = file.endsWith(".json") ? "application/json" : "application/octet-stream";
  process.stdout.write(`  ${file} ... `);
  await uploadFileToR2(join(dir, file), `piper-voices/${file}`, contentType);
  uploaded++;
  console.log("ok");
}
console.log(`Done. Uploaded ${uploaded}/${files.length} files.`);

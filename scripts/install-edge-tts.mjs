import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const root = process.cwd();
const venvDir = resolve(root, ".edge-tts-venv");
const edgeTtsBin =
  process.platform === "win32"
    ? join(venvDir, "Scripts", "edge-tts.exe")
    : join(venvDir, "bin", "edge-tts");
const pythonBin =
  process.platform === "win32"
    ? join(venvDir, "Scripts", "python.exe")
    : join(venvDir, "bin", "python");

function quoteIfNeeded(value) {
  return typeof value === "string" && value.includes(" ") && !value.startsWith('"') ? `"${value}"` : value;
}

function run(command, args, options = {}) {
  // shell:true on Windows joins the command + args with plain spaces without
  // quoting them — any piece containing a space (e.g. an install path like
  // "Program Files" or "AI Video Studio") silently gets split into two
  // tokens by cmd.exe. Quote both the command itself and every arg.
  const isWin = process.platform === "win32";
  const quotedCommand = isWin ? quoteIfNeeded(command) : command;
  const quotedArgs = isWin ? args.map(quoteIfNeeded) : args;
  const result = spawnSync(quotedCommand, quotedArgs, {
    stdio: "inherit",
    shell: isWin,
    ...options,
  });
  return result.status === 0;
}

function findPython() {
  const candidates =
    process.platform === "win32"
      ? [
          ["py", ["-3"]],
          ["python", []],
          ["python3", []],
        ]
      : [
          ["python3", []],
          ["python", []],
        ];

  for (const [command, prefixArgs] of candidates) {
    const ok = spawnSync(command, [...prefixArgs, "--version"], {
      stdio: "ignore",
      shell: process.platform === "win32",
    }).status === 0;
    if (ok) return { command, prefixArgs };
  }

  return null;
}

if (existsSync(edgeTtsBin) && existsSync(pythonBin)) {
  console.log(`edge-tts virtualenv already exists: ${edgeTtsBin}`);
  console.log("Ensuring gTTS fallback is installed");
  if (!run(pythonBin, ["-m", "pip", "install", "gTTS"])) {
    console.error("Failed to install gTTS fallback.");
    process.exit(1);
  }
  process.exit(0);
}

const python = findPython();
if (!python) {
  console.error("Python is required to install edge-tts, but no python command was found.");
  process.exit(1);
}

console.log(`Creating edge-tts virtualenv at ${venvDir}`);
if (!run(python.command, [...python.prefixArgs, "-m", "venv", venvDir])) {
  console.error("Failed to create edge-tts virtualenv.");
  process.exit(1);
}

console.log("Installing edge-tts and gTTS into virtualenv");
if (!run(pythonBin, ["-m", "pip", "install", "--upgrade", "pip", "edge-tts", "gTTS"])) {
  console.error("Failed to install edge-tts.");
  process.exit(1);
}

if (!existsSync(edgeTtsBin)) {
  console.error(`edge-tts was installed, but binary was not found at ${edgeTtsBin}`);
  process.exit(1);
}

console.log(`edge-tts installed: ${edgeTtsBin}`);

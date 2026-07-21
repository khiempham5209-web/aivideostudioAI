import { spawn } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { FFMPEG_BIN, PIPER_PYTHON } from "../utils/binaries.js";

export interface SupertonicOpts {
  /** One of Supertonic's built-in voice styles: M1-M5, F1-F5. */
  voiceName: string;
}

function run(command: string, args: string[], stdin?: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(command, args, { windowsHide: true });
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => (code === 0 ? resolvePromise() : reject(new Error(`${command} failed (exit ${code}): ${stderr.slice(-800)}`))));
    proc.on("error", reject);
    if (stdin !== undefined) {
      proc.stdin.write(stdin, "utf-8");
      proc.stdin.end();
    }
  });
}

export class SupertonicClient {
  private voiceName: string;

  constructor(options: SupertonicOpts) {
    this.voiceName = options.voiceName;
  }

  async generate(text: string, audioOutPath: string, srtOutPath?: string): Promise<void> {
    const wavPath = `${audioOutPath}.supertonic.wav`;
    const scriptPath = resolve("scripts", "supertonic-synth.py");
    await run(PIPER_PYTHON, [scriptPath, this.voiceName, wavPath], text);
    await run(FFMPEG_BIN, ["-y", "-i", wavPath, "-codec:a", "libmp3lame", "-qscale:a", "4", audioOutPath]);
    await rm(wavPath, { force: true });

    if (srtOutPath) {
      await writeFile(srtOutPath, "", "utf-8");
    }
  }
}

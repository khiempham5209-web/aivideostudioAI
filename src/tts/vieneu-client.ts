import { spawn } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { TtsClient } from "./tts-client.js";
import { FFMPEG_BIN, VIENEU_PYTHON } from "../utils/binaries.js";

export interface VieneuOpts {
  /** One of VieNeu's preset voice names, e.g. "Ngọc Huyền". */
  voiceName: string;
}

const SYNTH_TIMEOUT_MS = 120_000;

function run(command: string, args: string[], stdin?: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(command, args, { windowsHide: true });
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill("SIGKILL");
      reject(new Error(`${command} timed out after ${SYNTH_TIMEOUT_MS}ms (hung, no exit)`));
    }, SYNTH_TIMEOUT_MS);
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      code === 0 ? resolvePromise() : reject(new Error(`${command} failed (exit ${code}): ${stderr.slice(-800)}`));
    });
    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    if (stdin !== undefined) {
      proc.stdin.write(stdin, "utf-8");
      proc.stdin.end();
    }
  });
}

/** VieNeu-TTS — an open-source Vietnamese TTS with its own dedicated
 *  phonemizer (sea-g2p), not espeak-ng. Confirmed by direct A/B testing
 *  against a paragraph containing every tone pair Piper got wrong (ở/ớ,
 *  gần/gân, rõ/ró, nghĩ/nghí, etc.) — VieNeu's "Ngọc Huyền" preset voice
 *  read them correctly where all 31 local Piper voices didn't. Runs
 *  entirely offline via ONNX Runtime once its model weights are cached,
 *  same as Piper/Supertonic, just in its own venv (see VIENEU_PYTHON's
 *  comment in binaries.ts for why it can't share .edge-tts-venv). */
export class VieneuClient implements TtsClient {
  private voiceName: string;

  constructor(options: VieneuOpts) {
    this.voiceName = options.voiceName;
  }

  async generate(text: string, audioOutPath: string, srtOutPath?: string): Promise<void> {
    const wavPath = `${audioOutPath}.vieneu.wav`;
    const scriptPath = resolve("scripts", "vieneu-synth.py");
    await run(VIENEU_PYTHON, [scriptPath, this.voiceName, wavPath], text);
    await run(FFMPEG_BIN, ["-y", "-i", wavPath, "-codec:a", "libmp3lame", "-qscale:a", "4", audioOutPath]);
    await rm(wavPath, { force: true });

    if (srtOutPath) {
      await writeFile(srtOutPath, "", "utf-8");
    }
  }
}

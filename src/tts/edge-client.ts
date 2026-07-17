import { execFile } from "child_process";
import { promisify } from "util";
import { writeFile } from "fs/promises";
import { resolve } from "path";
import { EDGE_TTS_BIN, EDGE_TTS_PYTHON } from "../utils/binaries.js";

const execFileAsync = promisify(execFile);

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export class EdgeTtsClient {
  private voice: string;
  private speed: number;
  private static queue: Promise<void> = Promise.resolve();

  constructor(options?: { voice?: string; speed?: number }) {
    this.voice = options?.voice ?? "vi-VN-HoaiMyNeural";
    this.speed = options?.speed ?? 1;
  }

  private rateArg(): string {
    const clamped = Math.min(2, Math.max(0.5, this.speed));
    const pct = Math.round((clamped - 1) * 100);
    return `${pct >= 0 ? "+" : ""}${pct}%`;
  }

  private async generateWithFallback(text: string, audioOutPath: string): Promise<void> {
    const inputPath = `${audioOutPath}.txt`;
    await writeFile(inputPath, text, "utf-8");
    await execFileAsync(EDGE_TTS_PYTHON, [
      resolve("scripts", "gtts-fallback.py"),
      inputPath,
      audioOutPath,
    ]);
  }

  async generate(text: string, audioOutPath: string, srtOutPath?: string): Promise<void> {
    EdgeTtsClient.queue = EdgeTtsClient.queue.then(async () => {
      let lastError: unknown;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await execFileAsync(EDGE_TTS_BIN, [
            "--voice",
            this.voice,
            "--rate",
            this.rateArg(),
            "--text",
            text,
            "--write-media",
            audioOutPath
          ]);

          if (srtOutPath) {
            await writeFile(srtOutPath, "", "utf-8");
          }

          await sleep(1500);
          return;
        } catch (err) {
          lastError = err;
          await sleep(3000);
        }
      }

      console.warn(
        `Edge TTS failed after retries, falling back to gTTS: ${errorMessage(lastError)}`,
      );
      await this.generateWithFallback(text, audioOutPath);
      if (srtOutPath) {
        await writeFile(srtOutPath, "", "utf-8");
      }
      await sleep(500);
    });

    return EdgeTtsClient.queue;
  }
}

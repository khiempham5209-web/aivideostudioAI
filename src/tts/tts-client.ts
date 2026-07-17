/**
 * Common TTS client interface.
 */
export interface TtsClient {
  generate(text: string, audioOutPath: string, srtOutPath?: string): Promise<void>;
}

import type { Config } from "../config.js";
import { EdgeTtsClient } from "./edge-client.js";
import { OmniVoiceClient } from "./omnivoice-client.js";

export interface TtsSelection {
  voiceName?: string;
  speed?: number;
}

export function createTtsClient(cfg: Config, selection: TtsSelection = {}): TtsClient {
  if (cfg.ttsProvider === "edge") {
    return new EdgeTtsClient({
      voice: selection.voiceName ?? cfg.ttsVoiceName,
      speed: selection.speed ?? cfg.ttsSpeed,
    });
  }

  return new OmniVoiceClient({ endpoint: cfg.omnivoiceEndpoint });
}

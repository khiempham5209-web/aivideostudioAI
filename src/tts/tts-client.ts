/**
 * Common TTS client interface.
 */
export interface TtsClient {
  generate(text: string, audioOutPath: string, srtOutPath?: string): Promise<void>;
}

import type { Config, TtsProvider } from "../config.js";
import { EdgeTtsClient } from "./edge-client.js";
import { OmniVoiceClient } from "./omnivoice-client.js";
import { PiperClient } from "./piper-client.js";

export interface TtsSelection {
  provider?: TtsProvider;
  voiceName?: string;
  speed?: number;
}

export function createTtsClient(cfg: Config, selection: TtsSelection = {}): TtsClient {
  const provider = selection.provider ?? cfg.ttsProvider;
  if (provider === "edge") {
    return new EdgeTtsClient({
      voice: selection.voiceName ?? cfg.ttsVoiceName,
      speed: selection.speed ?? cfg.ttsSpeed,
    });
  }
  if (provider === "piper") {
    return new PiperClient({ voiceId: selection.voiceName ?? "vi_VN-vivos-x_low" });
  }

  return new OmniVoiceClient({ endpoint: cfg.omnivoiceEndpoint });
}

export type VoiceProvider = "edge" | "omnivoice" | "piper" | "supertonic";
export type VoiceGender = "male" | "female";
export type VoiceRegion = "north" | "central" | "south" | "neutral";
export type VoiceTone = "story" | "news" | "warm" | "dramatic" | "calm" | "sales";
export type VoiceStatus = "ready" | "needs-server";

export interface VoiceOption {
  id: string;
  name: string;
  label: string;
  gender: VoiceGender;
  region: VoiceRegion;
  tone: VoiceTone;
  provider: VoiceProvider;
  source: string;
  status: VoiceStatus;
  runtimeVoiceName: string;
  description: string;
}

export const VOICE_OPTIONS: VoiceOption[] = [
  {
    id: "edge-hoaimy-south-story",
    name: "vi-VN-HoaiMyNeural",
    runtimeVoiceName: "vi-VN-HoaiMyNeural",
    label: "Hoai My",
    gender: "female",
    region: "south",
    tone: "story",
    provider: "edge",
    source: "Microsoft Edge TTS",
    status: "ready",
    description: "Nu, mien Nam, hop ke chuyen va review ngan.",
  },
  {
    id: "edge-namminh-north-news",
    name: "vi-VN-NamMinhNeural",
    runtimeVoiceName: "vi-VN-NamMinhNeural",
    label: "Nam Minh",
    gender: "male",
    region: "north",
    tone: "news",
    provider: "edge",
    source: "Microsoft Edge TTS",
    status: "ready",
    description: "Nam, mien Bac, ro rang cho review va tin ngan.",
  },
  {
    id: "piper-vivos",
    name: "vi_VN-vivos-x_low",
    runtimeVoiceName: "vi_VN-vivos-x_low",
    label: "Piper - Vivos",
    gender: "female",
    region: "neutral",
    tone: "calm",
    provider: "piper",
    source: "Piper TTS (local, offline)",
    status: "ready",
    description: "Giong local offline, chat luong x_low. Tu dong chuyen sang Edge TTS neu gap tu hiem loi phat am.",
  },
  {
    id: "piper-vais1000",
    name: "vi_VN-vais1000-medium",
    runtimeVoiceName: "vi_VN-vais1000-medium",
    label: "Piper - Vais1000",
    gender: "female",
    region: "neutral",
    tone: "news",
    provider: "piper",
    source: "Piper TTS (local, offline)",
    status: "ready",
    description: "Giong local offline, chat luong medium. Tu dong chuyen sang Edge TTS neu gap tu hiem loi phat am.",
  },
  {
    id: "piper-25hours",
    name: "vi_VN-25hours_single-low",
    runtimeVoiceName: "vi_VN-25hours_single-low",
    label: "Piper - 25hours",
    gender: "male",
    region: "neutral",
    tone: "story",
    provider: "piper",
    source: "Piper TTS (local, offline)",
    status: "ready",
    description: "Giong local offline, chat luong low. Tu dong chuyen sang Edge TTS neu gap tu hiem loi phat am.",
  },
  {
    id: "supertonic-f1",
    name: "F1",
    runtimeVoiceName: "F1",
    label: "Supertonic - Nu 1 (F1)",
    gender: "female",
    region: "neutral",
    tone: "calm",
    provider: "supertonic",
    source: "Supertonic (local, offline)",
    status: "ready",
    description: "Giong local offline, chay CPU, on dinh voi tu tieng Viet (khong gap loi nhu Piper).",
  },
  {
    id: "supertonic-f2",
    name: "F2",
    runtimeVoiceName: "F2",
    label: "Supertonic - Nu 2 (F2)",
    gender: "female",
    region: "neutral",
    tone: "story",
    provider: "supertonic",
    source: "Supertonic (local, offline)",
    status: "ready",
    description: "Giong local offline, chay CPU.",
  },
  {
    id: "supertonic-f3",
    name: "F3",
    runtimeVoiceName: "F3",
    label: "Supertonic - Nu 3 (F3)",
    gender: "female",
    region: "neutral",
    tone: "news",
    provider: "supertonic",
    source: "Supertonic (local, offline)",
    status: "ready",
    description: "Giong local offline, chay CPU.",
  },
  {
    id: "supertonic-f4",
    name: "F4",
    runtimeVoiceName: "F4",
    label: "Supertonic - Nu 4 (F4)",
    gender: "female",
    region: "neutral",
    tone: "warm",
    provider: "supertonic",
    source: "Supertonic (local, offline)",
    status: "ready",
    description: "Giong local offline, chay CPU.",
  },
  {
    id: "supertonic-f5",
    name: "F5",
    runtimeVoiceName: "F5",
    label: "Supertonic - Nu 5 (F5)",
    gender: "female",
    region: "neutral",
    tone: "sales",
    provider: "supertonic",
    source: "Supertonic (local, offline)",
    status: "ready",
    description: "Giong local offline, chay CPU.",
  },
  {
    id: "supertonic-m1",
    name: "M1",
    runtimeVoiceName: "M1",
    label: "Supertonic - Nam 1 (M1)",
    gender: "male",
    region: "neutral",
    tone: "calm",
    provider: "supertonic",
    source: "Supertonic (local, offline)",
    status: "ready",
    description: "Giong local offline, chay CPU, on dinh voi tu tieng Viet (khong gap loi nhu Piper).",
  },
  {
    id: "supertonic-m2",
    name: "M2",
    runtimeVoiceName: "M2",
    label: "Supertonic - Nam 2 (M2)",
    gender: "male",
    region: "neutral",
    tone: "story",
    provider: "supertonic",
    source: "Supertonic (local, offline)",
    status: "ready",
    description: "Giong local offline, chay CPU.",
  },
  {
    id: "supertonic-m3",
    name: "M3",
    runtimeVoiceName: "M3",
    label: "Supertonic - Nam 3 (M3)",
    gender: "male",
    region: "neutral",
    tone: "news",
    provider: "supertonic",
    source: "Supertonic (local, offline)",
    status: "ready",
    description: "Giong local offline, chay CPU.",
  },
  {
    id: "supertonic-m4",
    name: "M4",
    runtimeVoiceName: "M4",
    label: "Supertonic - Nam 4 (M4)",
    gender: "male",
    region: "neutral",
    tone: "dramatic",
    provider: "supertonic",
    source: "Supertonic (local, offline)",
    status: "ready",
    description: "Giong local offline, chay CPU.",
  },
  {
    id: "supertonic-m5",
    name: "M5",
    runtimeVoiceName: "M5",
    label: "Supertonic - Nam 5 (M5)",
    gender: "male",
    region: "neutral",
    tone: "sales",
    provider: "supertonic",
    source: "Supertonic (local, offline)",
    status: "ready",
    description: "Giong local offline, chay CPU.",
  },
  {
    id: "omni-female-north-warm",
    name: "omnivoice-female-north-warm",
    runtimeVoiceName: "omnivoice-female-north-warm",
    label: "Nu Bac am",
    gender: "female",
    region: "north",
    tone: "warm",
    provider: "omnivoice",
    source: "OmniVoice preset",
    status: "needs-server",
    description: "Preset mo rong cho giong nu mien Bac am, can OmniVoice API.",
  },
  {
    id: "omni-male-north-dramatic",
    name: "omnivoice-male-north-dramatic",
    runtimeVoiceName: "omnivoice-male-north-dramatic",
    label: "Nam Bac kich tinh",
    gender: "male",
    region: "north",
    tone: "dramatic",
    provider: "omnivoice",
    source: "OmniVoice preset",
    status: "needs-server",
    description: "Preset mo rong cho review phim kich tinh, can OmniVoice API.",
  },
  {
    id: "omni-female-central-calm",
    name: "omnivoice-female-central-calm",
    runtimeVoiceName: "omnivoice-female-central-calm",
    label: "Nu Trung tram",
    gender: "female",
    region: "central",
    tone: "calm",
    provider: "omnivoice",
    source: "OmniVoice preset",
    status: "needs-server",
    description: "Preset mien Trung nhe va cham, can voice clone hoac design.",
  },
  {
    id: "omni-male-central-story",
    name: "omnivoice-male-central-story",
    runtimeVoiceName: "omnivoice-male-central-story",
    label: "Nam Trung ke chuyen",
    gender: "male",
    region: "central",
    tone: "story",
    provider: "omnivoice",
    source: "OmniVoice preset",
    status: "needs-server",
    description: "Preset mien Trung cho ke chuyen, can OmniVoice API.",
  },
  {
    id: "omni-female-south-sales",
    name: "omnivoice-female-south-sales",
    runtimeVoiceName: "omnivoice-female-south-sales",
    label: "Nu Nam ban hang",
    gender: "female",
    region: "south",
    tone: "sales",
    provider: "omnivoice",
    source: "OmniVoice preset",
    status: "needs-server",
    description: "Preset nang luong cho quang cao, can OmniVoice API.",
  },
  {
    id: "omni-male-south-warm",
    name: "omnivoice-male-south-warm",
    runtimeVoiceName: "omnivoice-male-south-warm",
    label: "Nam Nam am",
    gender: "male",
    region: "south",
    tone: "warm",
    provider: "omnivoice",
    source: "OmniVoice preset",
    status: "needs-server",
    description: "Preset nam mien Nam am, can voice clone hoac design.",
  },
];

import { existsSync } from "node:fs";
import { join } from "node:path";
import { PIPER_VOICES_DIR, isSupertonicInstalled } from "../utils/binaries.js";

/** Piper/Supertonic voices are only "ready" on whichever instance actually
 *  set them up locally (the desktop app's first-run setup) — the deployed
 *  server never does (see scripts/install-edge-tts.mjs), so it should show
 *  them as unavailable instead of offering a voice that will fail. */
function effectiveStatus(voice: VoiceOption): VoiceStatus {
  if (voice.provider === "piper") {
    const modelPath = join(PIPER_VOICES_DIR, `${voice.name}.onnx`);
    return existsSync(modelPath) ? voice.status : "needs-server";
  }
  if (voice.provider === "supertonic") {
    return isSupertonicInstalled() ? voice.status : "needs-server";
  }
  return voice.status;
}

export function getEffectiveVoiceOptions(): VoiceOption[] {
  return VOICE_OPTIONS.map((voice) => ({ ...voice, status: effectiveStatus(voice) }));
}

export function findVoiceOption(idOrName?: string): VoiceOption {
  const options = getEffectiveVoiceOptions();
  const fallback = options[0];
  if (!idOrName) return fallback;
  return options.find((voice) => voice.id === idOrName || voice.name === idOrName) ?? fallback;
}

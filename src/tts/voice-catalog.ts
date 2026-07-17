export type VoiceProvider = "edge" | "omnivoice";
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

export function findVoiceOption(idOrName?: string): VoiceOption {
  const fallback = VOICE_OPTIONS[0];
  if (!idOrName) return fallback;
  return VOICE_OPTIONS.find((voice) => voice.id === idOrName || voice.name === idOrName) ?? fallback;
}

import { config as loadDotenv } from "dotenv";

loadDotenv({ path: ".env.local" });

export type TtsProvider = "omnivoice" | "edge" | "piper";

export interface Config {
    ttsProvider: TtsProvider;

    // OmniVoice (local TTS server)
    omnivoiceEndpoint: string;

    ttsConcurrency: number;

    ttsVoiceName: string;

    ttsSpeed: number;
}

function intDefault(name: string, def: number): number {
    const v = process.env[name];
    if (!v) return def;
    const n = parseInt(v, 10);
    if (isNaN(n))
        throw new Error(`Env var ${name} must be integer, got "${v}"`);
    return n;
}

function floatDefault(name: string, def: number): number {
    const v = process.env[name];
    if (!v) return def;
    const n = parseFloat(v);
    if (isNaN(n))
        throw new Error(`Env var ${name} must be number, got "${v}"`);
    return n;
}

export function loadConfig(): Config {
    const provider = (process.env.TTS_PROVIDER ?? "edge") as TtsProvider;
    if (provider !== "omnivoice" && provider !== "edge") {
        throw new Error(
            `TTS_PROVIDER must be "omnivoice" or "edge", got "${provider}"`,
        );
    }

    return {
        ttsProvider: provider,
        omnivoiceEndpoint:
            process.env.OMNIVOICE_ENDPOINT ?? "http://127.0.0.1:8123",
        ttsConcurrency: intDefault("TTS_CONCURRENCY", 1),
        ttsVoiceName: process.env.TTS_VOICE_NAME ?? "vi-VN-HoaiMyNeural",
        ttsSpeed: floatDefault("TTS_SPEED", 1),
    };
}

import sys
from pathlib import Path
from vieneu import Vieneu

_client = None

# Voices cloned from the user's own recordings. The catalog passes
# "clone:<name>" as the voice name; the reference audio lives at
# assets/voices/<name>.wav (copied into the desktop build with assets/).
CLONE_PREFIX = "clone:"
VOICES_DIR = Path(__file__).resolve().parent.parent / "assets" / "voices"

def get_client():
    global _client
    if _client is None:
        _client = Vieneu()
    return _client

def main():
    if len(sys.argv) < 3:
        print("Usage: vieneu-synth.py <voice_name|clone:name> <output_wav_path>", file=sys.stderr)
        sys.exit(1)
    voice_name = sys.argv[1]
    output_path = sys.argv[2]
    # sys.stdin.read() decodes using the OS default codepage on Windows
    # (not UTF-8), which mangles Vietnamese text piped in as UTF-8 bytes —
    # same fix as supertonic-synth.py. Read raw bytes and decode explicitly.
    text = sys.stdin.buffer.read().decode("utf-8")

    client = get_client()
    # VieNeu-TTS samples speech tokens autoregressively (temperature=0.8
    # default) — every infer() call is an independent random draw, so two
    # scenes read back to back with the same voice preset can still land on
    # noticeably different prosody/energy ("lạc tone" — reported directly by
    # a real user hearing two adjacent lines sound like different moods).
    # Lowering temperature tightens that per-call variance toward the
    # model's most likely (average) rendering, trading a little expressive
    # range for take-to-take consistency, without touching pronunciation
    # accuracy (that's governed by the reference voice codes, not sampling).
    if voice_name.startswith(CLONE_PREFIX):
        ref = VOICES_DIR / f"{voice_name[len(CLONE_PREFIX):]}.wav"
        if not ref.is_file():
            print(f"Reference voice not found: {ref}", file=sys.stderr)
            sys.exit(2)
        audio = client.infer(text, ref_audio=str(ref), temperature=0.5)
    else:
        audio = client.infer(text, voice=voice_name, temperature=0.5)
    client.save(audio, output_path)

if __name__ == "__main__":
    main()

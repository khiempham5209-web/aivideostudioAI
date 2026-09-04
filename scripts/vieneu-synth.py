import sys
from vieneu import Vieneu

_client = None

def get_client():
    global _client
    if _client is None:
        _client = Vieneu()
    return _client

def main():
    if len(sys.argv) < 3:
        print("Usage: vieneu-synth.py <voice_name> <output_wav_path>", file=sys.stderr)
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
    audio = client.infer(text, voice=voice_name, temperature=0.5)
    client.save(audio, output_path)

if __name__ == "__main__":
    main()

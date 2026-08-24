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
    audio = client.infer(text, voice=voice_name)
    client.save(audio, output_path)

if __name__ == "__main__":
    main()

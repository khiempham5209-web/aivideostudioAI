import sys
from supertonic import TTS

def main():
    if len(sys.argv) < 3:
        print("Usage: supertonic-synth.py <voice_name> <output_wav_path>", file=sys.stderr)
        sys.exit(1)
    voice_name = sys.argv[1]
    output_path = sys.argv[2]
    # sys.stdin.read() decodes using the OS default codepage on Windows
    # (not UTF-8), which mangles Vietnamese text piped in as UTF-8 bytes.
    # Read the raw bytes and decode explicitly instead.
    text = sys.stdin.buffer.read().decode("utf-8")

    tts = TTS(auto_download=True)
    style = tts.get_voice_style(voice_name=voice_name)
    wav, _ = tts.synthesize(text, voice_style=style, lang="vi")
    tts.save_audio(wav, output_path)

if __name__ == "__main__":
    main()

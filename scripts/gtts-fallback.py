import sys
from pathlib import Path

from gtts import gTTS


def main() -> int:
    if len(sys.argv) != 3:
        print("Usage: gtts-fallback.py <input-text-file> <output-mp3>", file=sys.stderr)
        return 2

    input_path = Path(sys.argv[1])
    output_path = Path(sys.argv[2])
    text = input_path.read_text(encoding="utf-8").strip()

    if not text:
        print("No text provided for TTS.", file=sys.stderr)
        return 2

    output_path.parent.mkdir(parents=True, exist_ok=True)
    tts = gTTS(text=text, lang="vi")
    tts.save(str(output_path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

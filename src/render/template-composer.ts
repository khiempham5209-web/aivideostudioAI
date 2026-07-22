import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { log } from "../utils/logger.js";
import { FFMPEG_BIN, FFPROBE_BIN } from "../utils/binaries.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Repo-root/templates — where vendored HyperFrames templates live. */
const TEMPLATES_DIR = join(__dirname, "..", "..", "templates");

export type Aspect = "16:9" | "9:16" | "1:1";

/**
 * Each aspect renders a dedicated composition file authored at that native
 * canvas (these templates use absolute-px layouts, so we re-lay-out per aspect
 * rather than scale a single composition). Missing file → fall back to index.html.
 */
const ASPECT_ENTRY: Record<Aspect, string> = {
    "16:9": "index.html",
    "9:16": "compositions/portrait.html",
    "1:1": "compositions/square.html",
};

export interface ComposeArgs {
    /** Folder name under templates/, e.g. "frame-bold-poster". */
    templateId: string;
    /** Content slots, matching the template's data-composition-variables schema. */
    inputs: Record<string, unknown>;
    /** Absolute or repo-relative output .mp4 path. */
    outputPath: string;
    /** Force an output aspect. Omit to render the template's native canvas. */
    aspect?: Aspect;
    fps?: number;
    quality?: "draft" | "standard" | "high";
}

/**
 * Render one vendored HyperFrames template into an MP4, injecting `inputs`
 * as composition variables. This is the deterministic "fill the slots" step:
 * the agent only supplies text, the template owns all the visual design.
 */
export async function composeTemplate(args: ComposeArgs): Promise<string> {
    const { templateId, inputs, fps = 30, quality = "standard", aspect } = args;
    const templateDir = join(TEMPLATES_DIR, templateId);
    if (!existsSync(join(templateDir, "index.html"))) {
        throw new Error(`Template not found: ${templateDir}/index.html`);
    }

    // Pick the composition file for the requested aspect (fall back to index.html).
    const entry = aspect ? ASPECT_ENTRY[aspect] : "index.html";
    const entryFile = existsSync(join(templateDir, entry))
        ? entry
        : "index.html";

    const outputPath = isAbsolute(args.outputPath)
        ? args.outputPath
        : resolve(process.cwd(), args.outputPath);

    // Pass variables via a temp file, NOT --variables: a JSON arg through
    // npx + shell:true on Windows mangles quotes/Unicode (em-dash, Vietnamese)
    // and the render silently no-ops. A file is shell-safe and UTF-8 clean.
    const varsFile = join(
        mkdtempSync(join(tmpdir(), "hf-vars-")),
        "variables.json",
    );
    writeFileSync(varsFile, JSON.stringify(inputs), "utf8");

    // shell:true (required below to resolve npx.cmd on Windows) does NOT
    // auto-quote array arguments — Node just joins them with spaces and hands
    // the string to cmd.exe (this is exactly what its own DEP0190 warning is
    // about). Any path containing a space (e.g. "...\AI Video Studio\...",
    // a real install path on this machine) silently truncates at the first
    // space once cmd.exe re-tokenizes it. Quote every argument defensively.
    const q = (s: string) => `"${s}"`;
    const spawnArgs = [
        // -y: never prompt to install. Pinned version → deterministic renders.
        "-y",
        "hyperframes@0.6.94",
        "render",
        q(templateDir),
        "--composition",
        entryFile,
        "--output",
        q(outputPath),
        "--fps",
        String(fps),
        "--quality",
        quality,
        "--variables-file",
        q(varsFile),
    ];

    log.info(`Compose ${templateId} (${entryFile}) → ${outputPath}`);

    // hyperframes has no way to know about our bundled ffmpeg-static/
    // ffprobe-static binaries (normally invoked by full path via FFMPEG_BIN/
    // FFPROBE_BIN, never on PATH) unless explicitly told — it reads these
    // two exact env vars (confirmed in its own source, src/browser/ffmpeg.ts)
    // rather than searching PATH by default.
    const childEnv = {
        ...process.env,
        HYPERFRAMES_FFMPEG_PATH: FFMPEG_BIN,
        HYPERFRAMES_FFPROBE_PATH: FFPROBE_BIN,
    };

    await new Promise<void>((resolve, reject) => {
        const proc = spawn("npx", spawnArgs, {
            stdio: ["ignore", "inherit", "inherit"],
            shell: true,
            windowsHide: true,
            env: childEnv,
        });
        proc.on("close", (code) =>
            code === 0
                ? resolve()
                : reject(new Error(`hyperframes render failed (exit ${code})`)),
        );
        proc.on("error", reject);
    });

    log.info(`Rendered: ${outputPath}`);
    return outputPath;
}

/** POC entry: `tsx src/render/template-composer.ts` renders sample clips. */
// pathToFileURL handles Windows backslash paths (a raw `file://${argv[1]}`
// never matches import.meta.url on win32, silently skipping this block).
if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href
) {
    const inputs = {
        kicker: "AI Coding",
        date: "12 · 06 · 2026",
        figure: "5.5",
        headline: ["GPT 5.5", "ra mắt.", "Mạnh nhất."],
        standfirst:
            "OpenAI vừa công bố mô hình mạnh nhất từ trước tới nay — nhanh hơn, rẻ hơn, hiểu tiếng Việt tốt hơn.",
        footer_left: "AI Coding",
        footer_right: "https://aicodingvn.vercel.app/",
    };
    (async () => {
        await composeTemplate({
            templateId: "frame-bold-poster",
            inputs,
            aspect: "16:9",
            outputPath: "output/poc-bold-poster-16x9.mp4",
        });
        await composeTemplate({
            templateId: "frame-bold-poster",
            inputs,
            aspect: "9:16",
            outputPath: "output/poc-bold-poster-9x16.mp4",
        });
    })().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}

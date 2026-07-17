import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import dotenv from "dotenv";
import { generateScriptFromPrompt } from "./agent/prompt-to-script.js";
import { runTemplatePipeline } from "./render/template-pipeline.js";

dotenv.config({ path: ".env.local" });

const requestFile = resolve(process.env.REQUEST_FILE ?? "request.txt");
const reportTextFile = resolve(process.env.REPORT_TEXT_FILE ?? "last-run-report.txt");
const reportJsonFile = resolve(process.env.REPORT_JSON_FILE ?? "last-run-report.json");

function nowText() {
  return new Date().toLocaleString("vi-VN", { hour12: false });
}

function makeReport(data: {
  ok: boolean;
  prompt: string;
  message: string;
  outputDir?: string;
  scriptJson?: string;
  scriptText?: string;
  audio?: string;
  video?: string;
  error?: string;
}) {
  const lines = [
    `Thoi gian: ${nowText()}`,
    `Trang thai: ${data.ok ? "THANH CONG" : "LOI"}`,
    "",
    "De tai / yeu cau:",
    data.prompt || "(trong)",
    "",
    data.message,
  ];

  if (data.outputDir) {
    lines.push(
      "",
      "Ket qua:",
      `Output folder: ${data.outputDir}`,
      `Video: ${data.video}`,
      `Audio: ${data.audio}`,
      `Script JSON: ${data.scriptJson}`,
      `Script TXT: ${data.scriptText}`,
    );
  }

  if (data.error) {
    lines.push("", "Chi tiet loi:", data.error);
  }

  return lines.join("\n");
}

async function writeReports(report: Parameters<typeof makeReport>[0]) {
  await writeFile(reportTextFile, makeReport(report), "utf8");
  await writeFile(reportJsonFile, JSON.stringify(report, null, 2), "utf8");
}

async function main() {
  let prompt = "";

  try {
    prompt = (await readFile(requestFile, "utf8")).trim();
    if (!prompt) {
      throw new Error(`File request dang trong: ${requestFile}`);
    }

    console.log(`Doc yeu cau tu: ${requestFile}`);
    console.log(prompt);
    console.log("");
    console.log("Dang goi AI tao script...");

    const generated = await generateScriptFromPrompt(prompt);

    console.log(`Da tao script: ${resolve(generated.scriptPath)}`);
    console.log("Dang render video, buoc nay co the mat vai phut...");

    await runTemplatePipeline(generated.scriptPath);

    const outputDir = resolve(generated.outputDir);
    const report = {
      ok: true,
      prompt,
      message: "Da tao video xong.",
      outputDir,
      scriptJson: resolve(generated.outputDir, "script.json"),
      scriptText: resolve(generated.outputDir, "script.txt"),
      audio: resolve(generated.outputDir, "voice.mp3"),
      video: resolve(generated.outputDir, "video.mp4"),
    };

    await writeReports(report);
    console.log("");
    console.log("XONG.");
    console.log(`Bao cao: ${reportTextFile}`);
    console.log(`Video: ${report.video}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeReports({
      ok: false,
      prompt,
      message: "Chua tao duoc video.",
      error: message,
    });
    console.error(message);
    console.error(`Da ghi bao cao loi: ${reportTextFile}`);
    process.exit(1);
  }
}

main();

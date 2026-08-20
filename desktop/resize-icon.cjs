const { nativeImage } = require("electron");
const { join } = require("node:path");
const { writeFileSync } = require("node:fs");

const src = nativeImage.createFromPath(join(__dirname, "icon-source-512.png"));
const resized = src.resize({ width: 256, height: 256 });
writeFileSync(join(__dirname, "icon-256.png"), resized.toPNG());
console.log("wrote icon-256.png");

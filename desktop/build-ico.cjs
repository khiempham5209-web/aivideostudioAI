// Builds a proper, standards-compliant .ico (PNG-in-ICO container) directly
// from a PNG, instead of round-tripping through .NET's Icon.Save() (which
// produces a legacy-format ICO that trips up rcedit during electron-packager
// icon injection — "Invalid DataView length").
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const pngPath = join(__dirname, "icon-256.png");
const icoPath = join(__dirname, "icon.ico");
const png = readFileSync(pngPath);

// ICONDIR header: reserved(2)=0, type(2)=1 (icon), count(2)=1
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);

// ICONDIRENTRY: width(1) height(1) colors(1) reserved(1) planes(2) bpp(2) size(4) offset(4)
// 0 for width/height means 256px (per spec) — our source is 512, Windows
// will downscale from the embedded PNG's real dimensions fine.
const entry = Buffer.alloc(16);
entry.writeUInt8(0, 0); // width = 256
entry.writeUInt8(0, 1); // height = 256
entry.writeUInt8(0, 2); // no palette
entry.writeUInt8(0, 3); // reserved
entry.writeUInt16LE(1, 4); // color planes
entry.writeUInt16LE(32, 6); // bits per pixel
entry.writeUInt32LE(png.length, 8); // image data size
entry.writeUInt32LE(6 + 16, 12); // offset

writeFileSync(icoPath, Buffer.concat([header, entry, png]));
console.log("wrote", icoPath, "(", 6 + 16 + png.length, "bytes )");

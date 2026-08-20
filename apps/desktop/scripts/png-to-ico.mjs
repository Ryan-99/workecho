/**
 * 把 PNG 封装为 ICO（Vista+ 支持 ICO 内嵌 PNG）。
 * 用法：node scripts/png-to-ico.mjs <png路径> <ico输出路径>
 */
import { readFileSync, writeFileSync } from "node:fs";

const [,, pngPath, icoPath] = process.argv;
const png = readFileSync(pngPath);
const size = 512; // 尺寸字节（>255 时写 0 表示 256）

// ICO 头: reserved(2) + type(2)=1 + count(2)=1
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);

// 目录项: width(1) height(1) colors(1) reserved(1) planes(2) bpp(2) size(4) offset(4)
const entry = Buffer.alloc(16);
entry.writeUInt8(size >= 256 ? 0 : size, 0);
entry.writeUInt8(size >= 256 ? 0 : size, 1);
entry.writeUInt8(0, 2);
entry.writeUInt8(0, 3);
entry.writeUInt16LE(1, 4);
entry.writeUInt16LE(32, 6);
entry.writeUInt32LE(png.length, 8);
entry.writeUInt32LE(22, 12); // header(6) + entry(16)

writeFileSync(icoPath, Buffer.concat([header, entry, png]));
console.log(`ico written: ${icoPath}`);

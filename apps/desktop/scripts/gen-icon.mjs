/**
 * 用 Electron 无头窗口把黑色 logo SVG 栅格化为 PNG 应用图标。
 * 用法：npx electron scripts/gen-icon.mjs <svg路径> <输出png路径> <尺寸>
 */
import { app, BrowserWindow } from "electron";
import { writeFileSync, readFileSync } from "node:fs";

const [,, svgPath, outPath, sizeArg] = process.argv;
const size = parseInt(sizeArg ?? "512");

app.whenReady().then(async () => {
  const svg = readFileSync(svgPath, "utf-8");
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  const html = `<!doctype html><html><body style="margin:0">
<canvas id="c" width="${size}" height="${size}"></canvas>
<script>
const svg = ${JSON.stringify(svg)};
const img = new Image();
const canvas = document.getElementById("c");
const ctx = canvas.getContext("2d");
window.__done = new Promise((resolve) => {
  img.onload = () => {
    // 等比缩放居中绘制
    const s = Math.min(canvas.width / img.width, canvas.height / img.height);
    const w = img.width * s, h = img.height * s;
    ctx.drawImage(img, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
    resolve(canvas.toDataURL("image/png"));
  };
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
});
</script></body></html>`;
  await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  const dataUrl = await win.webContents.executeJavaScript("window.__done");
  const b64 = dataUrl.split(",")[1];
  writeFileSync(outPath, Buffer.from(b64, "base64"));
  console.log(`icon written: ${outPath} (${size}x${size})`);
  app.quit();
});

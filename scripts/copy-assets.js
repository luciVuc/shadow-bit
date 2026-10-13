// Copies the renderer's static assets (html/css/js) into dist after tsc,
// since TypeScript only compiles .ts files.
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const rendererSrc = path.join(root, "src", "gui", "renderer");
const rendererDest = path.join(root, "dist", "gui", "renderer");
const guiDest = path.join(root, "dist", "gui");

fs.mkdirSync(rendererDest, { recursive: true });
for (const file of fs.readdirSync(rendererSrc)) {
  if (file.endsWith(".ts")) continue; // .ts is compiled by tsc
  fs.copyFileSync(path.join(rendererSrc, file), path.join(rendererDest, file));
  console.log("copied", file);
}

// Copy the app icon next to the main process so the BrowserWindow and the
// packaged app can always find it (regardless of CWD).
const iconSrc = path.join(root, "build", "icon.png");
if (fs.existsSync(iconSrc)) {
  fs.copyFileSync(iconSrc, path.join(guiDest, "icon.png"));
  console.log("copied icon.png");
} else {
  console.log("skipped icon.png (run `npm run icons` first)");
}

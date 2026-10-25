// Fails the build when module.json is not installable by Foundry or points at files that do not exist.
import { existsSync, readFileSync } from "node:fs";

const m = JSON.parse(readFileSync("module.json", "utf8"));
const errors = [];
for (const key of ["id", "title", "version", "manifest", "download", "compatibility"]) {
  if (!m[key]) errors.push(`module.json is missing "${key}"`);
}
if (!/^\d+\.\d+\.\d+$/.test(m.version ?? "")) errors.push(`version "${m.version}" is not x.y.z`);
if (m.download && !m.download.includes(`/v${m.version}/`)) errors.push("download URL does not contain this version's tag");
for (const path of [...(m.esmodules ?? []), ...(m.styles ?? []), ...(m.languages ?? []).map((l) => l.path)]) {
  if (!existsSync(path)) errors.push(`listed file does not exist: ${path}`);
}
for (const path of ["styles/module.css", "templates/panel.hbs", "templates/profile-editor.hbs", "LICENSE", "ASSET_LICENSE.md"]) {
  if (!existsSync(path)) errors.push(`missing file: ${path}`);
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`module.json OK (${m.id} ${m.version})`);

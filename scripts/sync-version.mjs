import { readFileSync, writeFileSync } from "node:fs";

const version = JSON.parse(readFileSync("package.json", "utf8")).version;

const jsonFiles = [
  "plugins/exa/.claude-plugin/plugin.json",
  "plugin.json",
  "server.json",
  "gemini-extension.json",
  ".claude-plugin/plugin.json",
];

for (const file of jsonFiles) {
  const data = JSON.parse(readFileSync(file, "utf8"));
  data.version = version;
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

const marketplacePath = ".claude-plugin/marketplace.json";
const marketplace = JSON.parse(readFileSync(marketplacePath, "utf8"));
if (marketplace.metadata) marketplace.metadata.version = version;
if (Array.isArray(marketplace.plugins)) {
  for (const plugin of marketplace.plugins) {
    plugin.version = version;
  }
}
writeFileSync(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`, "utf8");

for (const file of ["src/stdio.ts", "api/mcp.ts"]) {
  const content = readFileSync(file, "utf8");
  if (!/version:\s*"[^"]+"/.test(content)) {
    throw new Error(`Could not find version literal in ${file}`);
  }
  const updated = content.replace(/version:\s*"[^"]+"/, `version: "${version}"`);
  writeFileSync(file, updated, "utf8");
}

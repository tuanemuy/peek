import { register } from "node:module";

register(
  `data:text/javascript,${encodeURIComponent(`
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function load(url, context, nextLoad) {
  const cleanUrl = url.split("?")[0];
  if (cleanUrl.endsWith(".css")) {
    const content = readFileSync(fileURLToPath(cleanUrl), "utf-8");
    return {
      format: "module",
      source: \`export default \${JSON.stringify(content)};\`,
      shortCircuit: true,
    };
  }
  return nextLoad(url, context);
}
`)}`,
);

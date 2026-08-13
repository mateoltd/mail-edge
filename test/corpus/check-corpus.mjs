import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";

const corpusUrl = new URL("./", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.json", corpusUrl), "utf8"));
const files = (await readdir(new URL("messages/", corpusUrl)))
  .filter((name) => name.endsWith(".eml"))
  .sort();
const declared = manifest.cases.map((entry) => entry.file).sort();
if (JSON.stringify(files) !== JSON.stringify(declared)) {
  throw new Error("Corpus manifest does not list exactly the committed message artifacts.");
}
for (const entry of manifest.cases) {
  if (entry.license !== "Apache-2.0" || entry.source !== "synthetic") {
    throw new Error(`Corpus case ${entry.id} has invalid provenance metadata.`);
  }
  const bytes = await readFile(new URL(`messages/${entry.file}`, corpusUrl));
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== entry.sha256) {
    throw new Error(`Corpus case ${entry.id} has SHA-256 ${digest}, expected ${entry.sha256}.`);
  }
}
console.log(`Verified ${String(manifest.cases.length)} synthetic mail corpus artifacts.`);

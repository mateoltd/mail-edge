import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { Extractor, ExtractorConfig } from "@microsoft/api-extractor";

import { publishableWorkspaceUnits } from "./workspace.mjs";

const packages = publishableWorkspaceUnits();
const generating = process.argv.includes("--generate");
let failed = false;

for (const unit of packages) {
  const configPath = resolve(unit.directory, "api-extractor.json");
  if (!existsSync(configPath)) {
    console.error(`${unit.name} is missing api-extractor.json.`);
    failed = true;
    continue;
  }

  const config = ExtractorConfig.loadFileAndPrepare(configPath);
  const result = Extractor.invoke(config, {
    localBuild: generating,
    showVerboseMessages: false,
  });
  failed ||= !result.succeeded;
}

if (packages.length === 0) {
  console.log("No publishable workspace packages exist yet; API Extractor policy is ready.");
}

if (failed) {
  process.exitCode = 1;
}

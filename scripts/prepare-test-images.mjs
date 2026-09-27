import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { repositoryRoot } from "./workspace.mjs";

const image = "mail-edge-test-minio:7ced9663e6a7";
const context = join(repositoryRoot, "test/fixtures/minio");
const recipeDigest = createHash("sha256")
  .update(readFileSync(join(context, "Dockerfile")))
  .update(readFileSync(join(context, "health.go")))
  .update(readFileSync(join(context, "initialize.go")))
  .digest("hex");
const label = "org.mateoltd.test-recipe-sha256";
let installedDigest;
try {
  installedDigest = execFileSync(
    "docker",
    ["image", "inspect", "--format", `{{ index .Config.Labels "${label}" }}`, image],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 },
  ).trim();
} catch {
  // A missing image is built below; Docker/build failures remain fatal.
}
if (installedDigest !== recipeDigest) {
  execFileSync(
    "docker",
    ["build", "--tag", image, "--label", `${label}=${recipeDigest}`, context],
    {
      stdio: "inherit",
      timeout: 15 * 60_000,
    },
  );
}
console.log(`Test MinIO image ready: ${image} (recipe ${recipeDigest}).`);

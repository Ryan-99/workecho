import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateConfiguration } from "app-builder-lib/out/util/config/config.js";
import { DebugLogger } from "builder-util";
import { parseDocument } from "yaml";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(scriptDir, "..", "..", "..");
const linuxPackageCommand = "electron-builder --linux --publish never";
const linuxDependencies = [
  "libgtk-3-0 | libgtk-3-0t64",
  "libnotify4",
  "libnss3",
  "libxss1",
  "libxtst6",
  "xdg-utils",
  "libatspi2.0-0 | libatspi2.0-0t64",
  "libuuid1",
  "libsecret-1-0",
  "libgbm1",
];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function parseYaml(relativePath) {
  const filePath = path.join(repoDir, relativePath);
  const document = parseDocument(await readFile(filePath, "utf8"), { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(
      `${relativePath} is invalid YAML: ${document.errors.map((error) => error.message).join("; ")}`,
    );
  }
  return document.toJS();
}

function stepNamed(job, name) {
  const step = job.steps?.find((candidate) => candidate.name === name);
  assert(step, `Missing workflow step "${name}"`);
  return step;
}

function runText(step) {
  return typeof step.run === "string" ? step.run : "";
}

function validateCiWorkflow(workflow) {
  const versionCheck = stepNamed(
    workflow.jobs?.typecheck,
    "Verify release version consistency",
  );
  assert(
    runText(versionCheck).includes("pnpm verify:release-version"),
    "CI must reject drift between product package versions",
  );

  const linuxJob = workflow.jobs?.["desktop-package-linux"];
  assert(linuxJob?.["runs-on"] === "ubuntu-latest", "Linux package CI must run on Ubuntu");
  assert(
    runText(stepNamed(linuxJob, "Verify Linux package configuration")).includes(
      "verify:release-config",
    ),
    "Linux package CI must validate release configuration before packaging",
  );
  assert(
    runText(stepNamed(linuxJob, "Package Linux AppImage and deb")).includes(
      "run package:linux",
    ),
    "Linux package CI must build the configured AppImage and deb targets",
  );
  assert(
    runText(stepNamed(linuxJob, "Verify Linux packages")).includes(
      "verify-linux-release.sh",
    ) &&
      runText(stepNamed(linuxJob, "Verify Linux packages")).includes("--install"),
    "Linux package CI must run native archive and install lifecycle verification",
  );

  const packageVerification = stepNamed(linuxJob, "Verify Linux packages");
  const candidateStage = stepNamed(linuxJob, "Stage validated Linux candidate");
  assert(
    runText(candidateStage).includes("release-artifacts.mjs stage"),
    "Linux package CI must validate actual outputs through the candidate manifest helper",
  );

  const candidateUpload = stepNamed(linuxJob, "Upload immutable Linux CI candidate");
  assert(
    candidateUpload.uses === "actions/upload-artifact@v4",
    "Linux CI candidate must use upload-artifact v4",
  );
  assert(
    candidateUpload.with?.path === "apps/desktop/release-candidate/",
    "Linux CI candidate upload must use only the staged file set",
  );
  assert(
    candidateUpload.with?.["if-no-files-found"] === "error",
    "Linux CI candidate upload must fail if staging produced no files",
  );

  const proofUpload = stepNamed(linuxJob, "Upload Linux package proof");
  assert(
    proofUpload.uses === "actions/upload-artifact@v4" &&
      proofUpload.with?.path === "apps/desktop/release-proof/linux/",
    "Linux CI must retain native package proof logs separately",
  );
  assert(
    Number(candidateUpload.with?.["retention-days"]) >= 14 &&
      Number(proofUpload.with?.["retention-days"]) >= 14,
    "Linux CI package proof must be retained for at least 14 days",
  );
  assert(
    linuxJob.steps.indexOf(packageVerification) < linuxJob.steps.indexOf(candidateStage) &&
      linuxJob.steps.indexOf(candidateStage) < linuxJob.steps.indexOf(candidateUpload),
    "Linux CI must complete native validation before staging and uploading a candidate",
  );
}

function validateBuilderConfig(config, desktopPackage, afterRemoveSource) {
  assert(config.mac?.notarize === true, "electron-builder must notarize the macOS app");
  assert(
    config.win?.signAndEditExecutable === true,
    "electron-builder must sign and edit the packaged Windows executable",
  );

  const targets = new Set((config.win?.target ?? []).map(({ target }) => target));
  assert(targets.has("nsis"), "Windows packaging must include NSIS");
  assert(targets.has("portable"), "Windows packaging must include portable");

  const setupName = "${productName}-${version}-${arch}-setup.${ext}";
  const portableName = "${productName}-${version}-${arch}-portable.${ext}";
  assert(config.nsis?.artifactName === setupName, `NSIS artifactName must be ${setupName}`);
  assert(
    config.portable?.artifactName === portableName,
    `portable artifactName must be ${portableName}`,
  );
  assert(
    config.nsis.artifactName !== config.portable.artifactName,
    "NSIS and portable artifacts must not share a filename",
  );

  assert(
    desktopPackage.homepage === "https://github.com/Ryan-99/workecho",
    "Desktop package metadata must provide the Debian Homepage",
  );
  assert(
    desktopPackage.scripts?.["package:linux"]?.includes(linuxPackageCommand),
    "pnpm Linux packaging must build AppImage and deb for x64",
  );

  assert(config.linux?.executableName === "workecho", "Linux executable name must remain workecho");
  assert(
    config.linux?.maintainer === "Matthew Lam <minghinmatthew.lam@gmail.com>",
    "Linux package maintainer must include an email address",
  );
  assert(
    config.linux?.synopsis === "Codex-style desktop app for the pi coding agent",
    "Linux package synopsis must remain explicit",
  );
  assert(
    JSON.stringify(config.linux?.target) ===
      JSON.stringify([
        { target: "AppImage", arch: ["x64"] },
        { target: "deb", arch: ["x64"] },
      ]),
    "Linux packaging must produce x64 AppImage and deb targets",
  );

  assert(
    config.deb?.artifactName === "${productName}_${version}_${arch}.${ext}",
    "Debian artifact naming must remain deterministic",
  );
  assert(config.deb?.packageName === "workecho", "Debian package name must remain workecho");
  assert(config.deb?.packageCategory === "devel", "Debian Section must remain devel");
  assert(config.deb?.priority === "optional", "Debian Priority must remain optional");
  assert(
    config.deb?.afterRemove === "resources/linux/after-remove.sh",
    "Debian packaging must use the corrected removal hook",
  );
  assert(
    JSON.stringify(config.deb?.depends) === JSON.stringify(linuxDependencies),
    "Debian dependencies must match the validated runtime dependency set",
  );
  assert(
    afterRemoveSource.includes(
      "update-alternatives --remove '${executable}' '/opt/${sanitizedProductName}/${executable}'",
    ) &&
      !afterRemoveSource.includes(
        "update-alternatives --remove '${executable}' '/usr/bin/${executable}'",
      ),
    "Debian removal must unregister the alternatives target, not the link",
  );
}

function validateBuildJob(job, platform) {
  const upload = stepNamed(job, `Upload immutable ${platform} candidate`);
  assert(upload.uses === "actions/upload-artifact@v4", `${platform} must use upload-artifact v4`);
  assert(
    upload.with?.["if-no-files-found"] === "error",
    `${platform} candidate upload must fail when files are missing`,
  );
  assert(upload.with?.overwrite !== true, `${platform} candidate upload must remain immutable`);

  const stage = stepNamed(job, `Stage validated ${platform} artifacts`);
  assert(
    runText(stage).includes("release-artifacts.mjs stage"),
    `${platform} candidate must be staged through the release manifest helper`,
  );
}

function validateWorkflow(workflow) {
  // Workecho 发布流程（.github/workflows/release.yml，2026-08-24 重写）：
  // tag 触发 → win/mac 双平台（各含单测 + 版本一致性 + 产物运行时校验）→ 聚合 Release。
  const jobs = workflow.jobs ?? {};
  const allRunText = JSON.stringify(workflow);

  assert(
    !allRunText.includes("extraMetadata.version"),
    "Release must not override artifact versions via extraMetadata (masks tag/package drift)",
  );

  for (const jobName of ["build-windows", "build-macos"]) {
    const job = jobs[jobName];
    assert(job, `Release workflow must define ${jobName}`);
    const runs = (job.steps ?? []).map((step) => runText(step));
    const joined = runs.join("\n");
    assert(
      joined.includes("pnpm --filter @workecho/desktop run test:unit"),
      `${jobName} must run the desktop unit suite before packaging`,
    );
    assert(
      joined.includes('pnpm verify:release-version --tag "$GITHUB_REF_NAME"'),
      `${jobName} must verify the tag matches package.json versions`,
    );
    assert(joined.includes("pnpm typecheck"), `${jobName} must run typecheck`);
    assert(
      joined.includes("verify:packaged-runtime-deps"),
      `${jobName} must verify packaged runtime dependencies after building`,
    );
  }

  const releaseSteps = Object.entries(jobs).flatMap(([jobName, job]) =>
    (job.steps ?? [])
      .filter(({ uses }) => uses === "softprops/action-gh-release@v2")
      .map((step) => ({ jobName, step })),
  );
  assert(releaseSteps.length === 1, "Release workflow must have exactly one GitHub release action");
  assert(
    releaseSteps[0].jobName === "release",
    "Only the aggregated release job may upload release assets",
  );
  const release = releaseSteps[0].step;
  assert(
    String(release.with?.prerelease ?? "").includes("contains(github.ref_name, '-')"),
    "Release upload must mark prerelease tags (C-11: beta tags must not become Latest)",
  );
  assert(
    workflow.permissions?.contents === "write",
    "Release workflow needs contents:write to create the GitHub release",
  );
}

const [
  builderConfig,
  ciWorkflow,
  workflow,
  desktopPackageSource,
  afterRemoveSource,
] = await Promise.all([
  parseYaml("apps/desktop/electron-builder.yml"),
  parseYaml(".github/workflows/ci.yml"),
  parseYaml(".github/workflows/release.yml"),
  readFile(path.join(scriptDir, "..", "package.json"), "utf8"),
  readFile(path.join(scriptDir, "..", "resources", "linux", "after-remove.sh"), "utf8"),
]);

await validateConfiguration(builderConfig, new DebugLogger(false));
validateBuilderConfig(builderConfig, JSON.parse(desktopPackageSource), afterRemoveSource);
validateCiWorkflow(ciWorkflow);
validateWorkflow(workflow);
console.log("Release package and workflow configuration are valid.");

import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { ERROR_CODES } from "../src/core/errors.js";
import {
  isPathInside,
  isProtectedProposalPath,
  pathsOverlap,
  resolveWorkingSet,
} from "../src/security/path-policy.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map(async (path) => {
      await rm(path, { recursive: true, force: true });
    }),
  );
});

async function makeRepository(): Promise<{
  readonly allowed: string;
  readonly repository: string;
  readonly nested: string;
}> {
  const allowed = await mkdtemp(join(tmpdir(), "ccw-path-"));
  cleanupPaths.push(allowed);
  const repository = join(allowed, "repository");
  const nested = join(repository, "src", "nested");
  await mkdir(join(repository, ".git"), { recursive: true });
  await mkdir(nested, { recursive: true });
  return { allowed, repository, nested };
}

describe("path containment", () => {
  test("uses path components rather than unsafe string prefixes", () => {
    const parent = join(tmpdir(), "repo");
    expect(isPathInside(parent, parent)).toBe(true);
    expect(isPathInside(parent, join(parent, "src"))).toBe(true);
    expect(isPathInside(parent, `${parent}-evil`)).toBe(false);
    expect(pathsOverlap(join(parent, "src"), join(parent, "src", "deep"))).toBe(
      true,
    );
    expect(pathsOverlap(join(parent, "src"), join(parent, "tests"))).toBe(
      false,
    );
  });

  test("rejects cross-drive Windows paths with pure win32 semantics", () => {
    expect(isPathInside("C:\\allowed", "C:\\allowed\\nested", win32)).toBe(
      true,
    );
    expect(isPathInside("C:\\allowed", "D:\\outside", win32)).toBe(false);
    expect(pathsOverlap("C:\\state", "D:\\repository", win32)).toBe(false);
  });
});

describe("protected proposal paths", () => {
  test.each([
    ".git/config",
    "nested/.GIT/index",
    ".gitmodules",
    ".env",
    "config/.env.production",
    ".npmrc",
    ".pypirc",
    "credentials.json",
    "id_rsa",
    "id_ed25519",
    "tls/server.pem",
    "tls/server.key",
  ])("protects sensitive path %j", (path) => {
    expect(isProtectedProposalPath(path)).toBe(true);
  });

  test.each([
    ".env.example",
    ".env.sample",
    ".env.template",
    "docs/environment.md",
    "src/key-handler.ts",
  ])("allows non-secret template path %j", (path) => {
    expect(isProtectedProposalPath(path)).toBe(false);
  });
});

describe("resolveWorkingSet", () => {
  test("resolves a nested analysis directory to its repository root", async () => {
    const fixture = await makeRepository();
    const result = await resolveWorkingSet({
      cwd: fixture.nested,
      mode: "analyze",
      allowedRoots: [fixture.allowed],
    });

    expect(result.cwd).toBe(await realpath(fixture.nested));
    expect(result.repositoryRoot).toBe(await realpath(fixture.repository));
    expect(result.executionRoot).toBe(await realpath(fixture.nested));
    expect(result.writePaths).toBeUndefined();
  });

  test("rejects cwd outside the allowlist and repositories whose root is outside it", async () => {
    const fixture = await makeRepository();
    const outside = await mkdtemp(join(tmpdir(), "ccw-outside-"));
    cleanupPaths.push(outside);
    await mkdir(join(outside, ".git"));

    await expect(
      resolveWorkingSet({
        cwd: outside,
        mode: "analyze",
        allowedRoots: [fixture.allowed],
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_PATH });

    await expect(
      resolveWorkingSet({
        cwd: fixture.nested,
        mode: "analyze",
        allowedRoots: [join(fixture.repository, "src")],
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_PATH });
  });

  test("rejects a non-repository directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccw-no-repo-"));
    cleanupPaths.push(root);
    await expect(
      resolveWorkingSet({ cwd: root, mode: "analyze", allowedRoots: [root] }),
    ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_PATH });
  });

  test("keeps write scopes repository-relative, normalized, sorted, and unique", async () => {
    const fixture = await makeRepository();
    const result = await resolveWorkingSet({
      cwd: fixture.nested,
      mode: "proposal",
      writePaths: ["tests/unit", "src\\feature", "tests/unit"],
      allowedRoots: [fixture.allowed],
    });

    expect(result.executionRoot).toBe(await realpath(fixture.repository));
    expect(result.writePaths).toEqual(["src/feature", "tests/unit"]);
  });

  test("rejects write authority in analyze mode and missing proposal scopes", async () => {
    const fixture = await makeRepository();
    await expect(
      resolveWorkingSet({
        cwd: fixture.repository,
        mode: "analyze",
        writePaths: [],
        allowedRoots: [fixture.allowed],
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_REQUEST });
    await expect(
      resolveWorkingSet({
        cwd: fixture.repository,
        mode: "proposal",
        allowedRoots: [fixture.allowed],
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_REQUEST });
  });

  test.each([
    "",
    ".",
    "/absolute",
    "../escape",
    "src/../escape",
    "src//file.ts",
    "src/./file.ts",
    ".git",
    ".git/config",
    ".env",
    "config/.env.local",
    ".npmrc",
    "certs/release.pem",
    "C:/outside",
    "src/evil\0name",
  ])("rejects unsafe proposal scope %j", async (writePath) => {
    const fixture = await makeRepository();
    await expect(
      resolveWorkingSet({
        cwd: fixture.repository,
        mode: "proposal",
        writePaths: [writePath],
        allowedRoots: [fixture.allowed],
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_PATH });
  });

  test.runIf(process.platform !== "win32")(
    "rejects a cwd that is itself a symlink",
    async () => {
      const fixture = await makeRepository();
      const linkedCwd = join(fixture.allowed, "linked-cwd");
      await symlink(fixture.nested, linkedCwd, "dir");
      await expect(
        resolveWorkingSet({
          cwd: linkedCwd,
          mode: "analyze",
          allowedRoots: [fixture.allowed],
        }),
      ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_PATH });
    },
  );
});

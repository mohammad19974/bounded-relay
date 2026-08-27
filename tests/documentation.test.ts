import { access, readFile, readdir } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

describe("repository documentation contract", () => {
  test("keeps package, executable, and generated brand assets aligned", async () => {
    const packageJson = JSON.parse(
      await readFile(resolve(projectRoot, "package.json"), "utf8"),
    ) as {
      readonly name: string;
      readonly bin: Readonly<Record<string, string>>;
    };

    expect(packageJson.name).toBe("boundedrelay");
    expect(packageJson.bin).toEqual({ boundedrelay: "./dist/cli.js" });
    await expect(
      access(resolve(projectRoot, "docs/assets/boundedrelay-cover.webp")),
    ).resolves.toBeUndefined();
    await expect(
      access(resolve(projectRoot, "docs/assets/boundedrelay-mark.webp")),
    ).resolves.toBeUndefined();
  });

  test("keeps every repository-local documentation link resolvable", async () => {
    const markdownFiles = [
      ...(await collectFiles(projectRoot, ".md", new Set(["node_modules"]))),
    ];
    const missing: string[] = [];

    for (const file of markdownFiles) {
      const source = await readFile(file, "utf8");
      for (const target of localTargets(source)) {
        const path = resolve(dirname(file), target);
        try {
          await access(path);
        } catch {
          missing.push(`${relativeToRoot(file)} -> ${target}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  test("keeps checked-in JSON examples and schemas parseable", async () => {
    const roots = ["schemas", "examples"];
    const invalid: string[] = [];

    for (const root of roots) {
      const files = await collectFiles(resolve(projectRoot, root), ".json");
      for (const file of files) {
        try {
          JSON.parse(await readFile(file, "utf8"));
        } catch {
          invalid.push(relativeToRoot(file));
        }
      }
    }

    expect(invalid).toEqual([]);
  });
});

async function collectFiles(
  root: string,
  extension: string,
  excluded = new Set<string>(),
): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (excluded.has(entry.name)) {
      continue;
    }
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(path, extension, excluded)));
    } else if (entry.isFile() && extname(entry.name) === extension) {
      files.push(path);
    }
  }
  return files;
}

function localTargets(markdown: string): readonly string[] {
  const targets: string[] = [];
  const patterns = [/\[[^\]]*\]\(([^)]+)\)/g, /(?:src|href)="([^"]+)"/g];
  for (const pattern of patterns) {
    for (const match of markdown.matchAll(pattern)) {
      const raw = match[1]?.trim();
      if (
        raw === undefined ||
        raw.startsWith("#") ||
        raw.startsWith("http://") ||
        raw.startsWith("https://") ||
        raw.startsWith("mailto:")
      ) {
        continue;
      }
      const withoutTitle = raw.split(/\s+["']/u, 1)[0] ?? raw;
      const target = withoutTitle.replace(/^<|>$/g, "").split("#", 1)[0] ?? "";
      if (target !== "") {
        targets.push(decodeURIComponent(target));
      }
    }
  }
  return targets;
}

function relativeToRoot(path: string): string {
  return path.slice(projectRoot.length);
}

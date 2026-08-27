import { createHash } from "node:crypto";

export const MAX_ARTIFACTS = 64;
export const MAX_ARTIFACT_PATH_CHARS = 4_096;
export const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
export const MAX_TOTAL_ARTIFACT_BYTES = 8 * 1024 * 1024;
export const MAX_EVIDENCE_BYTES = 64 * 1024;
export const MAX_FINDINGS = 100;
export const MAX_REVIEW_SCOPE_PATHS = 256;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const FULL_REVISION_PATTERN = /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class ReviewValidationError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "ReviewValidationError";
    this.code = code;
  }
}

export function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256Text(value: string): string {
  return sha256Bytes(Buffer.from(value, "utf8"));
}

export function expectRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ReviewValidationError(
      "INVALID_REVIEW_VALUE",
      `${label} must be an object`,
    );
  }
  return value as Record<string, unknown>;
}

export function assertOnlyKeys(
  record: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new ReviewValidationError(
      "UNKNOWN_REVIEW_PROPERTY",
      `${label} contains unsupported properties: ${unknown.sort().join(", ")}`,
    );
  }
}

export function boundedText(
  value: unknown,
  label: string,
  maximum: number,
): string {
  if (typeof value !== "string") {
    throw new ReviewValidationError(
      "INVALID_REVIEW_TEXT",
      `${label} must be a string`,
    );
  }
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > maximum || hasUnsafeControl(trimmed)) {
    throw new ReviewValidationError(
      "INVALID_REVIEW_TEXT",
      `${label} must contain 1-${maximum} safe characters`,
    );
  }
  return trimmed;
}

export function optionalBoundedText(
  value: unknown,
  label: string,
  maximum: number,
): string | undefined {
  return value === undefined ? undefined : boundedText(value, label, maximum);
}

export function safeIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_IDENTIFIER_PATTERN.test(value)) {
    throw new ReviewValidationError(
      "INVALID_REVIEW_IDENTIFIER",
      `${label} must be a safe identifier no longer than 128 characters`,
    );
  }
  return value;
}

export function sha256Digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new ReviewValidationError(
      "INVALID_REVIEW_DIGEST",
      `${label} must be a lowercase SHA-256 digest`,
    );
  }
  return value;
}

export function fullRevision(
  value: unknown,
  label: string,
  required: boolean,
): string | null {
  if (value === null && !required) {
    return null;
  }
  if (typeof value !== "string" || !FULL_REVISION_PATTERN.test(value)) {
    throw new ReviewValidationError(
      "INVALID_REVIEW_REVISION",
      `${label} must be an exact full Git revision`,
    );
  }
  return value.toLowerCase();
}

export function safeArtifactPath(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_ARTIFACT_PATH_CHARS ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /^[A-Za-z]:/u.test(value) ||
    hasAnyControl(value)
  ) {
    throw unsafeArtifactPath(label);
  }
  const parts = value.split("/");
  if (
    parts.some(
      (part) => part === "" || part === "." || part === ".." || part === ".git",
    )
  ) {
    throw unsafeArtifactPath(label);
  }
  return value;
}

export function parseStrictJson(raw: unknown, label: string): unknown {
  if (
    typeof raw !== "string" ||
    Buffer.byteLength(raw, "utf8") > MAX_EVIDENCE_BYTES
  ) {
    throw new ReviewValidationError(
      "REVIEW_EVIDENCE_TOO_LARGE",
      `${label} exceeds the ${MAX_EVIDENCE_BYTES}-byte limit`,
    );
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith("```") || trimmed.endsWith("```")) {
    throw new ReviewValidationError(
      "FENCED_REVIEW_EVIDENCE",
      `${label} must be raw JSON, not fenced JSON`,
    );
  }
  if (trimmed === "") {
    throw new ReviewValidationError(
      "EMPTY_REVIEW_EVIDENCE",
      `${label} must not be empty`,
    );
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    throw new ReviewValidationError(
      "MALFORMED_REVIEW_EVIDENCE",
      `${label} must be valid JSON`,
    );
  }
}

export function expectLiteral<T extends string | number | boolean>(
  value: unknown,
  expected: T,
  label: string,
): T {
  if (value !== expected) {
    throw new ReviewValidationError(
      "INVALID_REVIEW_LITERAL",
      `${label} must be ${JSON.stringify(expected)}`,
    );
  }
  return expected;
}

function unsafeArtifactPath(label: string): ReviewValidationError {
  return new ReviewValidationError(
    "INVALID_REVIEW_ARTIFACT_PATH",
    `${label} must be a safe repository-relative path`,
  );
}

function hasUnsafeControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      ((codePoint >= 0 && codePoint <= 8) ||
        codePoint === 11 ||
        codePoint === 12 ||
        (codePoint >= 14 && codePoint <= 31) ||
        codePoint === 127)
    ) {
      return true;
    }
  }
  return false;
}

function hasAnyControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      ((codePoint >= 0 && codePoint <= 31) || codePoint === 127)
    ) {
      return true;
    }
  }
  return false;
}

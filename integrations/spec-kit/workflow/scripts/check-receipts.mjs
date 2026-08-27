import {
  assertIsoDate,
  assertSafeIdentifier,
  assertSha256,
  fail,
  safeRepositoryPath,
} from "./evidence-core.mjs";

const RECEIPT_KEYS = new Set([
  "id",
  "source",
  "profile",
  "commandLabel",
  "commandSha256",
  "cwd",
  "exitCode",
  "stdoutSha256",
  "stderrSha256",
  "testedTree",
  "startedAt",
  "completedAt",
]);

export function assertCheckReceipts(
  value,
  label,
  required = true,
  maximum = 32,
) {
  if (
    !Array.isArray(value) ||
    value.length > maximum ||
    (required && value.length === 0)
  ) {
    fail(
      `${label} must contain ${required ? `1-${maximum}` : `0-${maximum}`} receipts`,
    );
  }
  const ids = new Set();
  for (const [index, receipt] of value.entries()) {
    if (
      typeof receipt !== "object" ||
      receipt === null ||
      Array.isArray(receipt) ||
      Object.keys(receipt).some((key) => !RECEIPT_KEYS.has(key))
    ) {
      fail(`${label}[${index}] contains unsupported fields`);
    }
    assertSafeIdentifier(receipt.id, `${label}[${index}].id`);
    if (ids.has(receipt.id)) {
      fail(`${label} repeats receipt id ${receipt.id}`);
    }
    ids.add(receipt.id);
    if (receipt.source !== "host-executed") {
      fail(`${label}[${index}].source must be host-executed`);
    }
    assertSafeIdentifier(receipt.profile, `${label}[${index}].profile`);
    if (
      typeof receipt.commandLabel !== "string" ||
      receipt.commandLabel.trim() === "" ||
      receipt.commandLabel.length > 512 ||
      // eslint-disable-next-line no-control-regex -- command labels must reject every ASCII control character.
      /[\u0000-\u001f\u007f]/u.test(receipt.commandLabel)
    ) {
      fail(`${label}[${index}].commandLabel is invalid`);
    }
    assertSha256(receipt.commandSha256, `${label}[${index}].commandSha256`);
    if (receipt.cwd !== ".") {
      safeRepositoryPath(receipt.cwd, `${label}[${index}].cwd`);
    }
    if (receipt.exitCode !== 0) {
      fail(`${label}[${index}] must record a successful exit code`);
    }
    assertSha256(receipt.stdoutSha256, `${label}[${index}].stdoutSha256`);
    assertSha256(receipt.stderrSha256, `${label}[${index}].stderrSha256`);
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(receipt.testedTree)) {
      fail(`${label}[${index}].testedTree must be a full Git tree id`);
    }
    assertIsoDate(receipt.startedAt, `${label}[${index}].startedAt`);
    assertIsoDate(receipt.completedAt, `${label}[${index}].completedAt`);
    if (Date.parse(receipt.completedAt) < Date.parse(receipt.startedAt)) {
      fail(`${label}[${index}] completion precedes its start`);
    }
  }
  return value;
}

#!/usr/bin/env node

import { appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);

// Lets a test count how many probe subprocesses the worker actually spawns.
if (process.env.FAKE_PROBE_COUNT_PATH) {
  appendFileSync(process.env.FAKE_PROBE_COUNT_PATH, `${args.join(" ")}\n`);
}

if (args.length === 1 && args[0] === "--version") {
  process.stdout.write(
    process.env.FAKE_ECHO_AUTH === "1"
      ? `codex-cli ${process.env.OPENAI_API_KEY ?? "missing"}\n`
      : process.env.FAKE_ECHO_FORWARD === "1"
        ? `codex-cli ${process.env.FOO ?? "missing"}\n`
        : "codex-cli 99.0.0-test\n",
  );
  process.exit(0);
}

if (args[0] === "login" && args[1] === "status") {
  if (process.env.FAKE_LOGIN_FAIL === "1") {
    process.stderr.write("not logged in\n");
    process.exit(1);
  }
  process.stdout.write("logged in\n");
  process.exit(0);
}

if (args.length === 1 && args[0] === "--help") {
  process.stdout.write(
    process.env.FAKE_INCOMPATIBLE === "1"
      ? "usage: codex\n"
      : "--strict-config --sandbox --ask-for-approval --cd\n",
  );
  process.exit(0);
}

if (args[0] === "exec" && args[1] === "--help") {
  process.stdout.write(
    process.env.FAKE_INCOMPATIBLE === "1"
      ? "usage: codex exec\n"
      : "--json --ephemeral --ignore-user-config --ignore-rules --color --output-schema\n",
  );
  process.exit(0);
}

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});

process.stdin.on("end", () => {
  const capturePath = process.env.FAKE_CAPTURE_PATH;
  if (capturePath) {
    writeFileSync(
      capturePath,
      JSON.stringify({
        args,
        cwd: process.cwd(),
        prompt,
        delegationDepth: process.env.CCW_DELEGATION_DEPTH,
        leakedSecret: process.env.UNFORWARDED_SECRET,
      }),
      "utf8",
    );
  }

  if (process.env.FAKE_CODEX_SCENARIO === "proposal") {
    writeFileSync(
      resolve(process.cwd(), "src/allowed.ts"),
      "export const value = 2;\n",
      "utf8",
    );
  }

  // A policy-valid patch that is large enough to expose the MCP wire budget.
  if (process.env.FAKE_CODEX_SCENARIO === "proposal-large") {
    const line = `export const value = ${"9".repeat(48)};\n`;
    writeFileSync(
      resolve(process.cwd(), "src/allowed.ts"),
      line.repeat(Math.ceil(6_000_000 / line.length)),
      "utf8",
    );
  }

  switch (process.env.FAKE_CODEX_SCENARIO) {
    case "unsafe-event-type":
      emit({
        type: "secret.must-not-reach-status",
        payload: { secret: "must-not-reach-status" },
      });
      emit({
        type: "thread.started",
        thread_id: `thread-unsafe\n${"x".repeat(200)}`,
      });
      emit({
        type: "item.completed",
        item: { type: "agent_message", text: "safe final" },
      });
      emit({
        type: "turn.completed",
        usage: {
          input_tokens: 1,
          cached_input_tokens: 0,
          output_tokens: 1,
          reasoning_output_tokens: 0,
        },
      });
      break;
    case "malformed":
      process.stdout.write("{not-json}\n");
      break;
    case "no-final":
      emit({ type: "turn.completed", usage: {} });
      break;
    case "no-terminal":
      emit({
        type: "item.completed",
        item: { type: "agent_message", text: "message without terminal" },
      });
      break;
    case "output-limit":
      process.stdout.write("x".repeat(256_000));
      break;
    case "timeout":
      process.on("SIGTERM", () => process.exit(0));
      setInterval(() => undefined, 1_000);
      return;
    case "cancel":
      process.on("SIGTERM", () => process.exit(0));
      setInterval(() => undefined, 1_000);
      return;
    case "failure-event":
      emit({ type: "turn.failed", error: { message: "bad\u0000turn" } });
      break;
    case "stderr-failure":
      process.stderr.write("private\nerror\tmessage\n");
      process.exitCode = 7;
      break;
    case "failed-command-outer-zero":
      emit({ type: "thread.started", thread_id: "thread-failed-command" });
      emit({ type: "turn.started" });
      emit({
        type: "item.completed",
        item: {
          type: "command_execution",
          exit_code: 6,
          status: "failed",
        },
      });
      emit({
        type: "item.completed",
        item: {
          type: "agent_message",
          text: "All checks passed even though none ran successfully.",
        },
      });
      emit({ type: "turn.completed", usage: {} });
      break;
    case "failed-then-successful-command":
      emit({ type: "thread.started", thread_id: "thread-recovered-command" });
      emit({ type: "turn.started" });
      emit({
        type: "item.completed",
        item: {
          type: "command_execution",
          exit_code: 1,
          status: "failed",
        },
      });
      emit({
        type: "item.completed",
        item: {
          type: "command_execution",
          exit_code: 0,
          status: "completed",
        },
      });
      emit({
        type: "item.completed",
        item: { type: "agent_message", text: "Recovered after a failed probe." },
      });
      emit({ type: "turn.completed", usage: {} });
      break;
    case "sdd-review-approved": {
      const decision = JSON.stringify({
        schemaVersion: 1,
        verdict: "approved",
        summary: "The independently reviewed artifacts satisfy the gate.",
        findings: [],
      });
      emit({ type: "thread.started", thread_id: "thread-sdd-review" });
      emit({
        type: "item.completed",
        item: {
          type: "command_execution",
          exit_code: 0,
          status: "completed",
        },
      });
      emit({
        type: "item.completed",
        item: { type: "agent_message", text: decision },
      });
      emit({
        type: "turn.completed",
        usage: {
          input_tokens: 8,
          cached_input_tokens: 2,
          output_tokens: 4,
          reasoning_output_tokens: 1,
        },
      });
      break;
    }
    default:
      process.stdout.write(
        '{"type":"thread.started","thread_id":"thread-test"}\r\n',
      );
      emit({ type: "turn.started" });
      process.stdout.write('{"type":"future.event","payload":true}\n');
      emit({ type: "item.started", item: { type: "command_execution" } });
      emit({ type: "item.updated", item: { type: "command_execution" } });
      process.stdout.write(
        '{"type":"item.completed","item":{"type":"command_execution","exit_code":0,"status":"completed"}}\n',
      );
      emit({ type: "item.started", item: { type: "agent_message" } });
      process.stdout.write(
        '{"type":"item.completed","item":{"type":"agent_message","text":"fake final"}}\n',
      );
      emit({
        type: "turn.completed",
        usage: {
          input_tokens: 10,
          cached_input_tokens: 2,
          output_tokens: 4,
          reasoning_output_tokens: 1,
        },
      });
  }
});

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

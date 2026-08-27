import { ERROR_CODES, WorkerError } from "../core/errors.js";

export class JsonlDecoder {
  readonly #onValue: (value: unknown) => void;
  #buffer = "";

  public constructor(onValue: (value: unknown) => void) {
    this.#onValue = onValue;
  }

  public push(chunk: string): void {
    this.#buffer += chunk;
    this.#drain(false);
  }

  public finish(): void {
    this.#drain(true);
  }

  #drain(flush: boolean): void {
    const lines = this.#buffer.split("\n");
    this.#buffer = flush ? "" : (lines.pop() ?? "");

    for (const rawLine of lines) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line.trim() === "") {
        continue;
      }
      try {
        this.#onValue(JSON.parse(line) as unknown);
      } catch {
        throw new WorkerError(
          ERROR_CODES.PROTOCOL_ERROR,
          "Codex emitted a non-JSON line on stdout",
        );
      }
    }

    if (flush && this.#buffer.trim() !== "") {
      throw new WorkerError(
        ERROR_CODES.PROTOCOL_ERROR,
        "Codex ended with an incomplete JSONL record",
      );
    }
  }
}

// Offline Python worker process.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stat, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { hashFile } from "./transcriber.js";
const project = fileURLToPath(new URL("../../", import.meta.url));
const script = path.join(project, "src", "adapters", "speech_worker.py");
function invoke(python, input, { signal, onProgress = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const child = spawn(python, ["-u", script], {
      windowsHide: true,
      env: { ...process.env, HF_HUB_OFFLINE: "1", PYTHONUTF8: "1" },
    });
    let buffer = "",
      errors = "",
      result,
      failed;
    const cancel = () => {
      failed = new Error("Transcription was cancelled.");
      child.kill();
    };
    signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => {
      failed = new Error("Speech processing exceeded one hour.");
      child.kill();
    }, 3600000);
    child.on("error", (e) => {
      failed = e;
    });
    child.stdin.on("error", (e) => {
      failed ||= e;
    });
    child.stderr.on("data", (c) => {
      errors = (errors + c).slice(-4000);
    });
    child.stdout.on("data", (c) => {
      buffer += c.toString("utf8");
      if (buffer.length > 16 * 1024 * 1024) {
        failed = new Error("Speech result exceeds the size limit.");
        child.kill();
        return;
      }
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const value = JSON.parse(line);
          if (value.type === "result") result = value.data;
          else if (value.type === "progress") onProgress(value.data);
        } catch (e) {
          failed = new Error("Invalid speech worker response.");
          child.kill();
        }
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      if (failed || code !== 0 || !result)
        reject(
          failed ||
            new Error(errors || "Speech worker did not return a result."),
        );
      else resolve(result);
    });
    child.stdin.end(JSON.stringify(input));
  });
}
export class PythonSpeechRunner {
  constructor(options = {}) {
    this.options = options;
    this.invoke = options.invoke ?? invoke;
  }
  async capabilities() {
    try {
      const identity = await this.identity();
      return {
        available: true,
        language: "en",
        model: "small.en",
        local: true,
        identity,
        setup: "npm run setup:transcription",
      };
    } catch (error) {
      return {
        available: false,
        reason: error.message,
        setup: "npm run setup:transcription",
      };
    }
  }
  async configuration() {
    if (this.options.python && this.options.model) return this.options;
    if (
      process.env.MIDNIGHT_TRANSCRIPT_PYTHON &&
      process.env.MIDNIGHT_TRANSCRIPT_MODEL
    )
      return {
        python: process.env.MIDNIGHT_TRANSCRIPT_PYTHON,
        model: process.env.MIDNIGHT_TRANSCRIPT_MODEL,
      };
    const config = JSON.parse(
      await readFile(
        path.join(project, ".local", "transcription.json"),
        "utf8",
      ),
    );
    return {
      python: process.env.MIDNIGHT_TRANSCRIPT_PYTHON || config.python,
      model: process.env.MIDNIGHT_TRANSCRIPT_MODEL || config.model,
    };
  }
  async identity({ signal } = {}) {
    signal?.throwIfAborted();
    const config = await this.configuration();
    const files = [
      "model.bin",
      "config.json",
      "tokenizer.json",
      "vocabulary.txt",
    ].map((f) => path.join(config.model, f));
    const stats = await Promise.all(
      [config.python, script, ...files].map(async (f) => {
        const s = await stat(f);
        return [f, s.size, s.mtimeMs];
      }),
    );
    const packages = await this.invoke(
      config.python,
      { check: true },
      { signal },
    );
    const signature = JSON.stringify({ stats, packages });
    if (this.identityCache?.signature === signature)
      return this.identityCache.value;
    const hashes = await Promise.all(
      [script, ...files].map((f) => hashFile(f, signal)),
    );
    const value = {
      engine: "faster-whisper",
      model: "small.en",
      method: "speech-regions-v1",
      language: "en",
      device: "cpu",
      computeType: "int8",
      threads: 4,
      beamSize: 5,
      packages,
      fingerprint: createHash("sha256")
        .update(JSON.stringify({ hashes, packages }))
        .digest("hex"),
    };
    this.identityCache = { signature, value };
    return value;
  }
  async transcribe(audio, options, context) {
    const config = await this.configuration();
    return this.invoke(
      config.python,
      { audio, model: config.model, ...options },
      context,
    );
  }
}

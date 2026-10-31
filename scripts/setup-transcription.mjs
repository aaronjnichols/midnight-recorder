import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile, rename } from "node:fs/promises";
import { PythonSpeechRunner } from "../src/adapters/transcription-worker.js";
import { run } from "../src/adapters/media.js";

const root = fileURLToPath(new URL("../", import.meta.url));
try {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(
      "Set up local, offline English speech recognition. Default setup needs uv and downloads pinned Python packages and the small.en model.\nUse an existing runtime without downloads: node scripts/setup-transcription.mjs --python <absolute python path> --model <absolute model directory>",
    );
  } else {
    if (
      args.some(
        (a, i) => i % 2 === 0 && !["--python", "--model"].includes(a),
      ) ||
      args.length % 2
    )
      throw Error("Use both --python and --model, or no arguments.");
    let python, model;
    if (args.length) {
      if (!args.includes("--python") || !args.includes("--model"))
        throw Error("Use both --python and --model.");
      python = args[args.indexOf("--python") + 1];
      model = args[args.indexOf("--model") + 1];
      if (!path.isAbsolute(python) || !path.isAbsolute(model))
        throw Error("Python and model paths must be absolute.");
    } else {
      const env = path.join(root, ".local", "speech-runtime");
      const cache = path.join(root, ".local", "uv-cache");
      await mkdir(path.join(root, ".local"), { recursive: true });
      console.log("Install local speech packages. This step uses the network.");
      await run("uv", ["venv", "--python", "3.13", "--cache-dir", cache, env]);
      python = path.join(
        env,
        process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
      );
      await run("uv", [
        "pip",
        "install",
        "--cache-dir",
        cache,
        "--python",
        python,
        "-r",
        path.join(root, "src", "adapters", "transcription-requirements.txt"),
      ]);
      console.log(
        "Download the pinned small.en model. Speech processing will then work offline.",
      );
      const script =
        'import sys; from huggingface_hub import snapshot_download; print(snapshot_download("Systran/faster-whisper-small.en", revision="d1d751a5f8271d482d14ca55d9e2deeebbae577f", cache_dir=sys.argv[1], allow_patterns=["model.bin","config.json","tokenizer.json","vocabulary.txt"]))';
      model = (
        await run(python, [
          "-c",
          script,
          path.join(root, ".local", "speech-models"),
        ])
      ).trim();
    }
    const runner = new PythonSpeechRunner({ python, model });
    const status = await runner.capabilities();
    if (!status.available) throw Error(status.reason);
    const target = path.join(root, ".local", "transcription.json");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(
      target + ".tmp",
      JSON.stringify({ python, model }, null, 2),
    );
    await rename(target + ".tmp", target);
    console.log(
      JSON.stringify(
        { ready: true, configuration: target, identity: status.identity },
        null,
        2,
      ),
    );
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

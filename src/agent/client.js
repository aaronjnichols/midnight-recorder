import { readFile } from "node:fs/promises";
import path from "node:path";

export const dataRoot = () =>
  path.resolve(process.env.MIDNIGHT_DATA || ".local/data");

export async function execute(command, args = {}) {
  let connection;
  try {
    connection = JSON.parse(
      await readFile(path.join(dataRoot(), "connection.json"), "utf8"),
    );
  } catch {
    throw new Error(
      "Start Midnight Recorder first. Set MIDNIGHT_DATA if you use another data folder.",
    );
  }
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${connection.port}/command`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${connection.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ command, args }),
      signal: AbortSignal.timeout(120000),
    });
  } catch (error) {
    throw new Error(
      `Cannot connect to Midnight Recorder. Start the desktop app. ${error.message}`,
    );
  }
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Command failed.");
  return body.result;
}

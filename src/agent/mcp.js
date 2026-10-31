import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { commands } from "../application/service.js";
import { execute } from "./client.js";

const server = new Server(
  { name: "midnight-recorder", version: "0.1.0" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: commands,
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const result = await execute(
      request.params.name,
      request.params.arguments || {},
    );
    if (
      request.params.name === "inspect.result" &&
      result.frames.some((frame) => frame.data)
    ) {
      const metadata = {
        ...result,
        frames: result.frames.map(({ data, ...frame }) => frame),
      };
      const content = [{ type: "text", text: JSON.stringify(metadata) }];
      for (const [index, frame] of result.frames.entries()) {
        content.push({
          type: "text",
          text: `Frame ${index + 1}: edited time ${frame.seconds} seconds. Image ${frame.width} x ${frame.height}.`,
        });
        content.push({
          type: "image",
          mimeType: frame.mimeType,
          data: frame.data,
        });
      }
      return { content };
    }
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: error.message }] };
  }
});
await server.connect(new StdioServerTransport());

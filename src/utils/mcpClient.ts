// src/utils/mcpClient.ts

import { Client } from "@modelcontextprotocol/sdk/client/index";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio";
import { HttpClientTransport } from "@modelcontextprotocol/sdk/client/http";
import { SseClientTransport } from "@modelcontextprotocol/sdk/client/sse";
import { getConfig } from "../config/index";
import { getDefaultEnvironment } from "./environment";
import { resolveCommand } from "./commandResolver";

export interface McpServerConfiguration {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  capabilities?: any;
  transport?: "stdio" | "http" | "sse";
  url?: string;
}

// src/utils/mcpClient.ts
export async function createMcpClients() {
  const config = getConfig(); // Get the full config
  const clients = new Map<
    string,
    { client: Client; transport: unknown }
  >();

  for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
    let transport: unknown;

    const transportType = serverConfig.transport || "stdio";

    if (transportType === "http") {
      transport = new HttpClientTransport({ url: serverConfig.url ?? "" });
    } else if (transportType === "sse") {
      transport = new SseClientTransport({ url: serverConfig.url ?? "" });
    } else {
      const resolvedCommand = await resolveCommand(serverConfig.command);
      transport = new StdioClientTransport({
        command: resolvedCommand,
        args: serverConfig.args || [],
        env:
          (serverConfig.env as Record<string, string> | undefined) ||
          getDefaultEnvironment(),
      });
    }

    const client = new Client(
      { name: `ollama-client-${serverName}`, version: "1.0.0" },
      {
        capabilities: {
          tools: { call: true, list: true },
        },
      }
    );

    await client.connect(transport);
    clients.set(serverName, { client, transport });
  }

  return clients;
}

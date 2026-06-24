import { AsyncLocalStorage } from "node:async_hooks";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { TSchema } from "typebox";
import { Type } from "typebox";
import { callMcpTool, formatResourceContent, formatResourceList, toolParameters } from "./catalog.js";
import { loadMcpConfig } from "./config.js";
import { formatMcpServerTarget } from "./display.js";
import { handlePiElicitation } from "./elicitation.js";
import { McpManager } from "./manager.js";
import type { McpConfig, McpStatus } from "./types.js";
import { optionalString, requiredString } from "./tool-args.js";

const LIST_MCP_RESOURCES_TOOL = "list_mcp_resources";
const READ_MCP_RESOURCE_TOOL = "read_mcp_resource";

const ListResourcesParams = Type.Object({
  server: Type.Optional(Type.String({ description: "Optional MCP server name. When omitted, lists resources from every connected server." })),
});

const ReadResourceParams = Type.Object({
  server: Type.String({ description: "MCP server name exactly as returned by list_mcp_resources." }),
  uri: Type.String({ description: "Resource URI exactly as returned by list_mcp_resources." }),
});

/** Registers the OpenCode-compatible MCP client extension with Pi. */
export default function opencodeMcpExtension(pi: ExtensionAPI) {
  let manager: McpManager | undefined;
  let config: McpConfig = { servers: {} };
  let registeredToolNames = new Set<string>();
  let latestContext: ExtensionContext | undefined;
  const elicitationContexts = new AsyncLocalStorage<ExtensionContext | undefined>();

  async function ensureManager(ctx: ExtensionContext) {
    latestContext = ctx;
    if (manager) return manager;
    manager = new McpManager({
      cwd: ctx.cwd,
      onElicitation: (server, request) => handlePiElicitation(server, request, elicitationContexts.getStore() ?? latestContext),
      onToolsChanged: async () => {
        registerDynamicTools();
      },
    });
    return manager;
  }

  async function loadAndConnect(ctx: ExtensionContext) {
    latestContext = ctx;
    config = await loadMcpConfig({ cwd: ctx.cwd });
    const activeManager = await ensureManager(ctx);
    const previous = registeredToolNames;
    registeredToolNames = new Set();
    await activeManager.initialize(config);
    registerDynamicTools();
    deactivateTools([...previous].filter((name) => !registeredToolNames.has(name)));
  }

  function registerDynamicTools() {
    const activeManager = manager;
    if (!activeManager) return;

    const current = new Set<string>();
    for (const entry of activeManager.getToolEntries()) {
      current.add(entry.key);
      pi.registerTool({
        name: entry.key,
        label: `MCP ${entry.server}/${entry.name}`,
        description: entry.tool.description || `Call MCP tool ${entry.name} on server ${entry.server}`,
        promptSnippet: `Call MCP tool ${entry.name} on server ${entry.server}`,
        promptGuidelines: [`Use ${entry.key} only when the user needs the ${entry.name} MCP tool from server ${entry.server}.`],
        parameters: typeboxToolParameters(entry.tool),
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
          const latest = requireManager().getToolEntry(entry.key);
          if (!latest) throw new Error(`MCP tool ${entry.key} is not connected`);
          const toolInput = {
            client: latest.client,
            tool: latest.tool,
            args: isPlainRecord(params) ? params : {},
            timeout: latest.timeout,
            ...(signal ? { signal } : {}),
          };
          return elicitationContexts.run(ctx ?? latestContext, () => callMcpTool(toolInput));
        },
      });
    }

    if (activeManager.supportsResources()) {
      current.add(LIST_MCP_RESOURCES_TOOL);
      current.add(READ_MCP_RESOURCE_TOOL);
      registerResourceTools();
    }

    deactivateTools([...registeredToolNames].filter((name) => !current.has(name)));
    registeredToolNames = current;
    activateTools([...current]);
  }

  function registerResourceTools() {
    pi.registerTool({
      name: LIST_MCP_RESOURCES_TOOL,
      label: "List MCP Resources",
      description:
        "Lists resources provided by connected MCP servers. Resources provide context such as files, database schemas, or application-specific information.",
      promptSnippet: "List resources from connected MCP servers",
      promptGuidelines: [
        "Use list_mcp_resources before read_mcp_resource when the user asks about available MCP resources or does not provide an exact MCP URI.",
      ],
      parameters: ListResourcesParams,
      async execute(_toolCallId, params, signal) {
        const parsed = parseListResourcesArgs(params);
        const resourceServers = resourceServerNames();
        if (parsed.server && !resourceServers.includes(parsed.server)) {
          throw new Error(
            resourceServers.length === 0
              ? `MCP server "${parsed.server}" does not support resources`
              : `MCP server "${parsed.server}" does not support resources. Available resource servers: ${resourceServers.join(", ")}`,
          );
        }
        const result = await requireManager().resources(parsed.server, signal ? { signal } : {});
        const sorted = [...result.resources].sort((a, b) =>
          `${a.client}\u0000${a.name}\u0000${a.uri}`.localeCompare(`${b.client}\u0000${b.name}\u0000${b.uri}`),
        );
        const response = {
          resources: formatResourceList(sorted),
          ...(result.failures.length > 0 ? { failures: result.failures } : {}),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
          details: {
            count: sorted.length,
            servers: resourceServers,
            failures: result.failures.length,
            ...(parsed.server ? { server: parsed.server } : {}),
          },
        };
      },
    });

    pi.registerTool({
      name: READ_MCP_RESOURCE_TOOL,
      label: "Read MCP Resource",
      description: "Read a specific resource from an MCP server using the server name and resource URI.",
      promptSnippet: "Read a specific MCP resource by server and URI",
      promptGuidelines: [
        "Use read_mcp_resource only with an exact MCP server name and URI returned by list_mcp_resources or supplied by the user.",
      ],
      parameters: ReadResourceParams,
      async execute(_toolCallId, params, signal) {
        const parsed = parseReadResourceArgs(params);
        const content = await requireManager().readResource(parsed.server, parsed.uri, signal ? { signal } : {});
        const formatted = formatResourceContent(parsed.server, parsed.uri, content);
        return {
          content: [{ type: "text", text: formatted.text }, ...formatted.images],
          details: {
            server: parsed.server,
            uri: parsed.uri,
            contents: formatted.count,
            images: formatted.images.length,
          },
        };
      },
    });
  }

  function resourceServerNames() {
    const activeManager = manager;
    if (!activeManager) return [];
    return Array.from(activeManager.connectedClients())
      .filter(([, entry]) => entry.hasResources)
      .map(([name]) => name)
      .sort((a, b) => a.localeCompare(b));
  }

  function activateTools(names: string[]) {
    if (names.length === 0) return;
    const active = new Set(pi.getActiveTools());
    for (const name of names) active.add(name);
    pi.setActiveTools([...active]);
  }

  function deactivateTools(names: string[]) {
    if (names.length === 0) return;
    const active = new Set(pi.getActiveTools());
    for (const name of names) active.delete(name);
    pi.setActiveTools([...active]);
  }

  pi.on("session_start", async (_event, ctx) => {
    latestContext = ctx;
    await loadAndConnect(ctx);
    const count = Object.values(manager?.status() ?? {}).filter((status) => status.status === "connected").length;
    if (ctx.hasUI && Object.keys(config.servers).length > 0) {
      ctx.ui.setStatus("mcp", `${count} MCP`);
    }
  });

  pi.on("session_shutdown", async () => {
    await manager?.close();
    manager = undefined;
    registeredToolNames = new Set();
  });

  pi.registerCommand("mcp-list", {
    description: "List MCP servers and status",
    handler: async (_args, ctx) => {
      await ensureManager(ctx);
      showCommandMessage(pi, "MCP Servers", await statusText(requireManager(), config));
    },
  });

  pi.registerCommand("mcp-reload", {
    description: "Reload MCP config and reconnect servers",
    handler: async (_args, ctx) => {
      await loadAndConnect(ctx);
      showCommandMessage(pi, "MCP Reloaded", await statusText(requireManager(), config));
    },
  });

  pi.registerCommand("mcp-connect", {
    description: "Connect an MCP server: /mcp-connect <name>",
    getArgumentCompletions: (prefix) => completionItems(Object.keys(config.servers), prefix),
    handler: async (args, ctx) => {
      const name = args.trim();
      if (!name) {
        ctx.ui.notify("Usage: /mcp-connect <name>", "warning");
        return;
      }
      await ensureManager(ctx);
      const status = await requireManager().connect(name);
      registerDynamicTools();
      showCommandMessage(pi, `MCP Connect: ${name}`, formatStatus(name, config.servers[name], status));
    },
  });

  pi.registerCommand("mcp-disconnect", {
    description: "Disconnect an MCP server: /mcp-disconnect <name>",
    getArgumentCompletions: (prefix) => completionItems(Object.keys(config.servers), prefix),
    handler: async (args, ctx) => {
      const name = args.trim();
      if (!name) {
        ctx.ui.notify("Usage: /mcp-disconnect <name>", "warning");
        return;
      }
      await ensureManager(ctx);
      await requireManager().disconnect(name);
      registerDynamicTools();
      showCommandMessage(pi, `MCP Disconnect: ${name}`, `Disconnected ${name}`);
    },
  });

  pi.registerCommand("mcp-auth", {
    description: "Authenticate with an OAuth-enabled remote MCP server",
    getArgumentCompletions: (prefix) => completionItems(oauthServerNames(), prefix),
    handler: async (args, ctx) => {
      await ensureManager(ctx);
      let name = args.trim();
      if (!name) {
        const options = oauthServerNames();
        if (options.length === 0) {
          ctx.ui.notify("No OAuth-capable MCP servers configured", "warning");
          return;
        }
        name = (ctx.hasUI ? await ctx.ui.select("MCP OAuth server", options) : options[0]) ?? "";
      }
      if (!name) return;
      const status = await requireManager().authenticate(name, async (url) => {
        showCommandMessage(pi, "Open MCP OAuth URL", url);
      });
      registerDynamicTools();
      showCommandMessage(pi, `MCP Auth: ${name}`, formatStatus(name, config.servers[name], status));
    },
  });

  pi.registerCommand("mcp-logout", {
    description: "Remove OAuth credentials for an MCP server: /mcp-logout <name>",
    getArgumentCompletions: (prefix) => completionItems(Object.keys(config.servers), prefix),
    handler: async (args, ctx) => {
      const name = args.trim();
      if (!name) {
        ctx.ui.notify("Usage: /mcp-logout <name>", "warning");
        return;
      }
      await ensureManager(ctx);
      await requireManager().removeAuth(name);
      showCommandMessage(pi, `MCP Logout: ${name}`, `Removed OAuth credentials for ${name}`);
    },
  });

  pi.registerCommand("mcp-prompts", {
    description: "List prompts exposed by connected MCP servers",
    handler: async (_args, ctx) => {
      await ensureManager(ctx);
      const result = await requireManager().prompts();
      const prompts = result.prompts;
      const text =
        prompts.length === 0
          ? "No MCP prompts available."
          : prompts
              .map((prompt) => {
                const args = prompt.arguments?.map((argument) => argument.name).join(", ");
                return `- ${prompt.client}/${prompt.name}${args ? ` (${args})` : ""}${prompt.description ? `: ${prompt.description}` : ""}`;
              })
              .join("\n");
      const failures = result.failures.map((failure) => `- ${failure.server}: ${failure.error}`).join("\n");
      const output = failures ? `${text}\n\nPrompt servers with errors:\n${failures}` : text;
      showCommandMessage(pi, "MCP Prompts", output);
    },
  });

  pi.registerCommand("mcp-prompt", {
    description: "Fetch an MCP prompt and send it as a user message: /mcp-prompt <server> <prompt> [json args]",
    handler: async (args, ctx) => {
      await ensureManager(ctx);
      const parsed = parsePromptCommand(args);
      if (!parsed) {
        ctx.ui.notify("Usage: /mcp-prompt <server> <prompt> [json args]", "warning");
        return;
      }
      const prompt = await requireManager().getPrompt(parsed.server, parsed.prompt, parsed.args);
      const text =
        prompt.messages
          ?.map((message) => {
            const content = message.content;
            return typeof content === "object" && content && "type" in content && content.type === "text" ? content.text : "";
          })
          .filter((text) => text.length > 0)
          .join("\n") ?? "";
      if (!text.trim()) {
        ctx.ui.notify("MCP prompt returned no text content", "warning");
        return;
      }
      pi.sendUserMessage(text);
    },
  });

  function oauthServerNames() {
    return Object.entries(config.servers)
      .filter(([, server]) => server.type === "remote" && server.oauth !== false)
      .map(([name]) => name);
  }

  function requireManager() {
    if (!manager) throw new Error("MCP manager has not been initialized");
    return manager;
  }
}

function parseListResourcesArgs(value: unknown) {
  const args = isPlainRecord(value) ? value : {};
  return { server: optionalString(args, "server") };
}

function parseReadResourceArgs(value: unknown) {
  const args = isPlainRecord(value) ? value : {};
  return { server: requiredString(args, "server"), uri: requiredString(args, "uri") };
}

function parsePromptCommand(input: string) {
  const [server, prompt, ...rest] = input.trim().split(/\s+/);
  if (!server || !prompt) return undefined;
  const json = rest.join(" ").trim();
  if (!json) return { server, prompt };
  const parsed = JSON.parse(json);
  if (!isPlainRecord(parsed)) throw new Error("Prompt args must be a JSON object");
  return { server, prompt, args: Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value)])) };
}

function completionItems(values: string[], prefix: string) {
  const items = values
    .filter((value) => value.startsWith(prefix))
    .map((value) => ({ value, label: value }));
  return items.length > 0 ? items : null;
}

async function statusText(manager: McpManager, config: McpConfig) {
  const statuses = manager.status();
  const lines: string[] = [];
  if (config.source) lines.push(`Config: ${config.source}`, "");
  const servers = Object.entries(config.servers);
  if (servers.length === 0) return "No MCP servers configured.";
  for (const [name, serverConfig] of servers) {
    lines.push(formatStatus(name, serverConfig, statuses[name] ?? { status: "disabled" }));
    if (serverConfig.type === "remote" && serverConfig.oauth !== false) {
      lines.push(`  auth: ${await manager.authStatus(name)}`);
    }
  }
  return lines.join("\n");
}

function formatStatus(name: string, serverConfig: McpConfig["servers"][string] | undefined, status: McpStatus) {
  const target = formatMcpServerTarget(serverConfig);
  const detail =
    status.status === "failed" || status.status === "needs_client_registration"
      ? `\n  ${status.error}`
      : status.status === "needs_auth"
        ? "\n  Run /mcp-auth to authenticate."
        : "";
  return `${name}: ${status.status}${target ? `\n  ${target}` : ""}${detail}`;
}

function showCommandMessage(pi: ExtensionAPI, title: string, content: string) {
  pi.sendMessage(
    {
      customType: "pi-opencode-mcp",
      content: `## ${title}\n\n${content}`,
      display: true,
      details: { title },
    },
    { triggerTurn: false },
  );
}

function typeboxToolParameters(tool: Tool): TSchema {
  const parameters = toolParameters(tool);
  // SAFETY: Pi's extension API accepts TypeBox-compatible JSON Schema. normalizeToolSchema limits MCP schemas
  // to the JSON Schema subset used by TypeBox tool parameters before this interop boundary.
  return parameters as TSchema;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

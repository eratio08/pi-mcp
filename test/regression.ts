import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AuthStore } from "../src/auth-store.js";
import { loadMcpConfig } from "../src/config.js";
import { formatMcpServerTarget, redactSecrets } from "../src/display.js";
import { McpManager } from "../src/manager.js";
import type { McpConfig, McpServerConfig } from "../src/types.js";
import { root } from "./helpers.js";

async function main() {
  await rejectsInvalidServerConfig();
  await loadsProxyToolMode();
  await loadsStartupMode();
  await rejectsMissingEnvironmentPlaceholder();
  redactsDisplayTargets();
  await rejectsMalformedAuthStoreData();
  await acceptsEmptyOptionalAuthStrings();
  await rejectsUnavailableOAuthCallbackPort();
  await handlesClientCloseCallbackRejections();
  await rejectsDynamicToolKeyCollisions();
  await configuresWithoutConnecting();
  await automaticConnectSkipsConfigDisabledServers();
  await explicitConnectSkipsConfigDisabledServers();
  await explicitConnectClearsRuntimeDisconnect();
  await concurrentConnectsShareOneInFlightAttempt();
  await connectPropagatesCancellation();
  await returnsImmutableManagerSnapshots();
  await propagatesListCancellation();
  console.log("regression ok");
}

async function rejectsInvalidServerConfig() {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-mcp-invalid-config-"));
  await writeFile(
    path.join(dir, "opencode.json"),
    JSON.stringify({
      mcp: {
        broken: {
          type: "remote",
          urll: "https://example.test/mcp",
        },
      },
    }),
  );

  await assert.rejects(() => loadMcpConfig({ cwd: dir }), /mcp\.broken\.url must be a non-empty string/);
}

async function loadsProxyToolMode() {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-mcp-proxy-config-"));
  await writeFile(
    path.join(dir, "opencode.json"),
    JSON.stringify({
      mcp: {
        toolMode: "proxy",
        local: {
          type: "local",
          command: ["fixture-server"],
        },
      },
    }),
  );

  const config = await loadMcpConfig({ cwd: dir });
  assert.equal(config.toolMode, "proxy");
  assert.equal(config.servers.local?.type, "local");
  assert.deepEqual(config.servers.local.type === "local" ? config.servers.local.command : [], ["fixture-server"]);
}

async function loadsStartupMode() {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-mcp-startup-config-"));
  await writeFile(
    path.join(dir, "opencode.json"),
    JSON.stringify({
      mcp: {
        startup: "eager",
        local: {
          type: "local",
          command: ["fixture-server"],
        },
      },
    }),
  );

  const config = await loadMcpConfig({ cwd: dir });
  assert.equal(config.startup, "eager");
  assert.equal(config.servers.local?.type, "local");
}

async function rejectsMissingEnvironmentPlaceholder() {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-mcp-missing-env-"));
  delete process.env.PI_MCP_REGRESSION_TOKEN;
  await writeFile(
    path.join(dir, "opencode.json"),
    JSON.stringify({
      mcp: {
        remote: {
          type: "remote",
          url: "https://example.test/mcp",
          headers: {
            Authorization: "Bearer ${PI_MCP_REGRESSION_TOKEN}",
          },
        },
      },
    }),
  );

  await assert.rejects(() => loadMcpConfig({ cwd: dir }), /missing environment variable PI_MCP_REGRESSION_TOKEN/);
}

async function rejectsMalformedAuthStoreData() {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-mcp-authdata-"));
  const file = path.join(dir, "auth.json");
  await writeFile(
    file,
    JSON.stringify({
      oauth: {
        tokens: {
          accessToken: { not: "a string" },
          expiresAt: "not a number",
        },
        clientInfo: {
          clientId: 123,
        },
        oauthState: false,
        serverUrl: "https://example.test/mcp",
      },
    }),
  );

  const warnings: string[] = [];
  const previousWarn = console.warn;
  console.warn = (message?: unknown) => {
    warnings.push(String(message));
  };
  const store = new AuthStore(file);
  try {
    assert.equal(await store.get("oauth"), undefined);
    assert.equal(await store.authStatus("oauth"), "not_authenticated");
    assert.equal(await store.getOAuthState("oauth"), undefined);
    assert.equal(warnings.some((warning) => warning.includes("malformed persisted auth")), true);
  } finally {
    console.warn = previousWarn;
  }
}

async function acceptsEmptyOptionalAuthStrings() {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-mcp-auth-empty-strings-"));
  const file = path.join(dir, "auth.json");
  await writeFile(
    file,
    JSON.stringify({
      oauth: {
        tokens: {
          accessToken: "access-token",
          refreshToken: "",
          scope: "",
        },
        clientInfo: {
          clientId: "client-id",
          clientSecret: "",
        },
        codeVerifier: "",
        oauthState: "",
        serverUrl: "https://example.test/mcp",
      },
    }),
  );

  const store = new AuthStore(file);
  const entry = await store.get("oauth");
  assert.equal(entry?.tokens?.accessToken, "access-token");
  assert.equal(entry?.tokens?.refreshToken, "");
  assert.equal(entry?.tokens?.scope, "");
  assert.equal(entry?.clientInfo?.clientSecret, "");
  assert.equal(entry?.codeVerifier, "");
  assert.equal(entry?.oauthState, "");
  assert.equal(await store.authStatus("oauth"), "authenticated");
}

function redactsDisplayTargets() {
  assert.equal(
    formatMcpServerTarget({
      type: "remote",
      url: "https://user:password@example.test/mcp?token=SECRET123#fragment",
    }),
    "https://example.test/mcp?<redacted>#<redacted>",
  );
  assert.equal(
    formatMcpServerTarget({
      type: "local",
      command: ["fixture-server", "--token", "SECRET123"],
    }),
    "fixture-server (2 args)",
  );
  assert.equal(
    redactSecrets("GET https://user:pass@example.test/mcp?token=SECRET123#fragment Authorization: Bearer SECRET123"),
    "GET https://example.test/mcp?<redacted>#<redacted> Authorization: Bearer <redacted>",
  );
}

async function rejectsUnavailableOAuthCallbackPort() {
  const occupied = await listenOnFreePort();
  const config: McpConfig = {
    servers: {
      oauth: {
        type: "remote",
        url: "http://127.0.0.1:1/mcp",
        oauth: {
          callbackPort: occupied.port,
        },
        timeout: 100,
      },
    },
  };
  const manager = new McpManager({
    cwd: root,
    openAuthorizationUrl: () => {
      throw new Error("opener should not be called when callback port is unavailable");
    },
  });

  try {
    await manager.initialize(config, {
      mode: "connect",
      intent: "explicit",
      signal: undefined,
    });
    await assert.rejects(() => manager.authenticate("oauth"), /OAuth callback server could not listen/);
  } finally {
    await manager.close();
    await occupied.close();
  }
}

async function handlesClientCloseCallbackRejections() {
  const unhandled: string[] = [];
  const loggedErrors: string[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason instanceof Error ? reason.message : String(reason));
  };
  const previousConsoleError = console.error;
  console.error = (message?: unknown) => {
    loggedErrors.push(String(message));
  };
  process.once("unhandledRejection", onUnhandled);
  let onToolsChanged = async () => undefined;
  let onStatusChanged = async () => undefined;
  const manager = new McpManager({
    cwd: root,
    onToolsChanged: () => onToolsChanged(),
    onStatusChanged: () => onStatusChanged(),
  });

  try {
    await manager.initialize(
      {
        servers: {
          local: {
            type: "local",
            command: [process.execPath, "test/local-mcp-server.mjs"],
            timeout: 10_000,
          },
        },
      },
      {
        mode: "connect",
        intent: "explicit",
        signal: undefined,
      },
    );

    const connected = Array.from(manager.connectedClients().values());
    assert.equal(connected.length, 1);
    const managed = connected[0];
    assert.ok(managed, "expected connected MCP fixture");
    onToolsChanged = async () => {
      throw new Error("tools changed failed");
    };
    onStatusChanged = async () => {
      throw new Error("status changed failed");
    };
    managed.client.onclose?.();
    await sleep(50);
    assert.deepEqual(unhandled, []);
    assert.equal(loggedErrors.some((message) => message.includes("close handler failed")), true);
    await managed.client.close();
  } finally {
    console.error = previousConsoleError;
    process.removeListener("unhandledRejection", onUnhandled);
    await manager.close();
  }
}

async function rejectsDynamicToolKeyCollisions() {
  const manager = new McpManager({ cwd: root });
  try {
    await manager.initialize(
      {
        servers: {
          "a.b": {
            type: "local",
            command: [process.execPath, "test/local-mcp-server.mjs"],
            timeout: 10_000,
          },
          a_b: {
            type: "local",
            command: [process.execPath, "test/local-mcp-server.mjs"],
            timeout: 10_000,
          },
        },
      },
      {
        mode: "connect",
        intent: "explicit",
        signal: undefined,
      },
    );
    const statuses = manager.status();
    const finalStatuses = [statuses["a.b"], statuses.a_b];
    assert.equal(finalStatuses.filter((status) => status?.status === "connected").length, 1);
    assert.equal(finalStatuses.filter((status) => status?.status === "failed").length, 1);
    assert.equal(
      finalStatuses.some((status) => status?.status === "failed" && /tool name collision/.test(status.error)),
      true,
    );
    assert.equal(manager.getToolEntries().filter((entry) => entry.key === "a_b_echo").length, 1);
  } finally {
    await manager.close();
  }
}

async function configuresWithoutConnecting() {
  const manager = new McpManager({ cwd: root });
  try {
    await manager.initialize(
      {
        servers: {
          local: {
            type: "local",
            command: [process.execPath, "test/local-mcp-server.mjs"],
            timeout: 10_000,
          },
        },
      },
      { mode: "configure-only" },
    );
    assert.equal(manager.status().local?.status, "disconnected");
    assert.deepEqual(manager.getToolEntries(), []);

    await manager.connectAll({
      intent: "explicit",
      signal: undefined,
    });
    assert.equal(manager.status().local?.status, "connected");
    assert.equal(manager.getToolEntries().some((entry) => entry.key === "local_echo"), true);
  } finally {
    await manager.close();
  }
}

async function automaticConnectSkipsConfigDisabledServers() {
  const manager = new McpManager({ cwd: root });

  try {
    await manager.initialize(
      {
        servers: {
          off: {
            type: "local",
            command: [process.execPath, "test/local-mcp-server.mjs"],
            disabled: true,
            timeout: 10_000,
          },
        },
      },
      { mode: "configure-only" },
    );

    const status = await manager.connect("off", {
      intent: "automatic",
      signal: undefined,
    });

    assert.equal(status.status, "disabled");
    assert.equal(manager.status().off?.status, "disabled");
    assert.deepEqual(manager.getToolEntries(), []);
  } finally {
    await manager.close();
  }
}

async function explicitConnectSkipsConfigDisabledServers() {
  const manager = new McpManager({ cwd: root });

  try {
    await manager.initialize(
      {
        servers: {
          off: {
            type: "local",
            command: [process.execPath, "test/local-mcp-server.mjs"],
            disabled: true,
            timeout: 10_000,
          },
        },
      },
      { mode: "configure-only" },
    );

    const status = await manager.connect("off", {
      intent: "explicit",
      signal: undefined,
    });

    assert.equal(status.status, "disabled");
    assert.equal(manager.status().off?.status, "disabled");
    assert.deepEqual(manager.getToolEntries(), []);
  } finally {
    await manager.close();
  }
}

async function explicitConnectClearsRuntimeDisconnect() {
  const manager = new McpManager({ cwd: root });

  try {
    await manager.initialize(
      {
        servers: {
          local: {
            type: "local",
            command: [process.execPath, "test/local-mcp-server.mjs"],
            timeout: 10_000,
          },
        },
      },
      {
        mode: "connect",
        intent: "explicit",
        signal: undefined,
      },
    );

    await manager.disconnect("local");

    assert.equal(manager.status().local?.status, "disabled");

    const automaticStatus = await manager.connect("local", {
      intent: "automatic",
      signal: undefined,
    });

    assert.equal(automaticStatus.status, "disabled");

    const explicitStatus = await manager.connect("local", {
      intent: "explicit",
      signal: undefined,
    });

    assert.equal(explicitStatus.status, "connected");
    assert.equal(manager.getToolEntries().some((entry) => entry.key === "local_echo"), true);
  } finally {
    await manager.close();
  }
}

async function concurrentConnectsShareOneInFlightAttempt() {
  const startsDir = await mkdtemp(path.join(tmpdir(), "pi-mcp-starts-"));
  const startsFile = path.join(startsDir, "starts.txt");
  const script = await writeDelayedRecordingFixtureScript(startsFile, 300);
  const manager = new McpManager({ cwd: root });

  try {
    await manager.initialize(
      {
        servers: {
          slow: {
            type: "local",
            command: [process.execPath, script],
            timeout: 10_000,
          },
        },
      },
      { mode: "configure-only" },
    );

    const first = manager.connect("slow", {
      intent: "automatic",
      signal: undefined,
    });

    const second = manager.connect("slow", {
      intent: "automatic",
      signal: undefined,
    });

    const [firstStatus, secondStatus] = await Promise.all([first, second]);

    assert.equal(firstStatus.status, "connected");
    assert.equal(secondStatus.status, "connected");
    assert.equal(await readStartCount(startsFile), 1);
  } finally {
    await manager.close();
  }
}

async function connectPropagatesCancellation() {
  const startsDir = await mkdtemp(path.join(tmpdir(), "pi-mcp-starts-"));
  const startsFile = path.join(startsDir, "starts.txt");
  const script = await writeDelayedRecordingFixtureScript(startsFile, 300);
  const controller = new AbortController();
  const manager = new McpManager({ cwd: root });

  try {
    await manager.initialize(
      {
        servers: {
          slow: {
            type: "local",
            command: [process.execPath, script],
            timeout: 10_000,
          },
        },
      },
      { mode: "configure-only" },
    );

    const pending = manager.connect("slow", {
      intent: "automatic",
      signal: controller.signal,
    });

    controller.abort();

    await assert.rejects(() => pending, { name: "AbortError" });
  } finally {
    await manager.close();
  }
}

async function returnsImmutableManagerSnapshots() {
  const servers: Record<string, McpServerConfig> = {
    a: {
      type: "remote",
      url: "http://127.0.0.1:1/mcp",
      disabled: true,
    },
  };
  const manager = new McpManager({ cwd: root });
  await manager.initialize({ servers }, { mode: "configure-only" });

  servers.b = {
    type: "remote",
    url: "http://127.0.0.1:1/mcp",
    disabled: true,
  };
  assert.deepEqual(Object.keys(manager.status()), ["a"]);

  const status = manager.status();
  assert.ok(status.a);
  Reflect.set(status.a, "status", "connected");
  assert.equal(manager.status().a?.status, "disabled");

  const configured = manager.configuredServers();
  Reflect.set(configured, "c", {
    type: "remote",
    url: "http://127.0.0.1:1/mcp",
    disabled: true,
  });
  assert.deepEqual(Object.keys(manager.configuredServers()), ["a"]);
}

async function propagatesListCancellation() {
  const controller = new AbortController();
  controller.abort();
  const manager = new McpManager({ cwd: root });
  await assert.rejects(() => manager.resources(undefined, { signal: controller.signal }), { name: "AbortError" });
}

async function listenOnFreePort() {
  const server = createServer((_req, res) => {
    res.end("occupied");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(typeof address === "object" && address, "expected local server address");
  return {
    port: address.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function writeDelayedRecordingFixtureScript(startsFile: string, delayMs: number) {
  const script = path.join(await mkdtemp(path.join(tmpdir(), "pi-mcp-delayed-fixture-")), "fixture.mjs");
  await writeFile(
    script,
    `import { appendFile } from "node:fs/promises";\n` +
      `import { createRequire } from "node:module";\n` +
      `import { setTimeout as sleep } from "node:timers/promises";\n` +
      `import { pathToFileURL } from "node:url";\n` +
      `const require = createRequire(${JSON.stringify(path.join(root, "package.json"))});\n` +
      `const { McpServer } = await import(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/server/mcp.js")).href);\n` +
      `const { StdioServerTransport } = await import(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/server/stdio.js")).href);\n` +
      `const z = await import(pathToFileURL(require.resolve("zod/v4")).href);\n` +
      `await appendFile(${JSON.stringify(startsFile)}, "1\\n");\n` +
      `await sleep(${JSON.stringify(delayMs)});\n` +
      `const server = new McpServer({ name: "pi-mcp-delayed-fixture", version: "1.0.0" });\n` +
      `server.registerTool("echo", { title: "Echo", inputSchema: { message: z.string().optional() } }, async ({ message }) => ({ content: [{ type: "text", text: String(message ?? "") }] }));\n` +
      `await server.connect(new StdioServerTransport());\n`,
  );
  return script;
}

async function readStartCount(startsFile: string) {
  try {
    return (await readFile(startsFile, "utf8")).trim().split("\n").filter(Boolean).length;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return 0;
    throw error;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

await main();

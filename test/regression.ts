import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
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
  await rejectsMissingEnvironmentPlaceholder();
  redactsDisplayTargets();
  await rejectsMalformedAuthStoreData();
  await rejectsUnavailableOAuthCallbackPort();
  await handlesClientCloseCallbackRejections();
  await rejectsDynamicToolKeyCollisions();
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
    await manager.initialize(config);
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
    await manager.initialize({
      servers: {
        local: {
          type: "local",
          command: [process.execPath, "test/local-mcp-server.mjs"],
          timeout: 10_000,
        },
      },
    });

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
    await manager.initialize({
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
    });
    const statuses = manager.status();
    assert.equal(statuses["a.b"]?.status, "connected");
    assert.equal(statuses.a_b?.status, "failed");
    assert.match(statuses.a_b?.status === "failed" ? statuses.a_b.error : "", /tool name collision/);
    assert.equal(manager.getToolEntries().filter((entry) => entry.key === "a_b_echo").length, 1);
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
  await manager.initialize({ servers });

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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

await main();

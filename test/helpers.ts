import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { callMcpTool } from "../src/catalog.js";
import { McpManager } from "../src/manager.js";

export const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const fixturePath = path.join(root, "test", "local-mcp-server.mjs");

interface Fixture {
  url: string;
  child: ChildProcess;
}

interface OAuthFixture extends Fixture {
  statsUrl: string;
  expireUrl: string;
}

export async function callTool(manager: McpManager, key: string, args: Record<string, unknown>) {
  const entry = manager.getToolEntry(key);
  assert.ok(entry, `missing tool ${key}`);
  return callMcpTool({
    client: entry.client,
    tool: entry.tool,
    args,
    timeout: entry.timeout,
  });
}

export function startMcpFixture(options: { oauth: true }): Promise<OAuthFixture>;
export function startMcpFixture(options?: { oauth?: false }): Promise<Fixture>;
export async function startMcpFixture(options: { oauth?: boolean } = {}) {
  const args = options.oauth ? ["--http", "--oauth", "--port", "0"] : ["--http", "--port", "0"];
  const child = spawn(process.execPath, [fixturePath, ...args], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const exitPromise = once(child, "exit").then(([code, signal]) => {
    throw new Error(`MCP fixture exited before startup: code=${code} signal=${signal}\n${stderr}`);
  });

  const linePromise = new Promise<Fixture | OAuthFixture>((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      const line = stdout.slice(0, newline);
      try {
        const parsed: unknown = JSON.parse(line);
        const url = requiredString(parsed, "url");
        if (!options.oauth) {
          resolve({ url, child });
          return;
        }
        resolve({
          url,
          statsUrl: requiredString(parsed, "statsUrl"),
          expireUrl: requiredString(parsed, "expireUrl"),
          child,
        });
      } catch (error) {
        reject(error);
      }
    });
    child.on("error", reject);
  });

  return Promise.race([linePromise, exitPromise]);
}

export async function fixtureStats(url: string) {
  const response = await fetch(url);
  assert.equal(response.ok, true);
  const stats: unknown = await response.json();
  return {
    registrations: requiredNumber(stats, "registrations"),
    authorizationCodeGrants: requiredNumber(stats, "authorizationCodeGrants"),
    refreshGrants: requiredNumber(stats, "refreshGrants"),
    protectedRequests: requiredNumber(stats, "protectedRequests"),
  };
}

export async function findFreePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(typeof address === "object" && address, "expected callback probe address");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requiredString(value: unknown, key: string) {
  const item = property(value, key);
  if (typeof item !== "string") throw new Error(`missing ${key}`);
  return item;
}

function requiredNumber(value: unknown, key: string) {
  const item = property(value, key);
  if (typeof item !== "number") throw new Error(`missing ${key}`);
  return item;
}

function property(value: unknown, key: string) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return Reflect.get(value, key);
}

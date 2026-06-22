#!/usr/bin/env node
import { spawn } from "node:child_process";

function readPort(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--port" || arg === "-p" || arg === "-PORT") {
      return argv[i + 1];
    }
    const match = arg.match(/^--?port=(\d+)$/i);
    if (match) {
      return match[1];
    }
  }
  return process.env.PORT || "8080";
}

const serverPort = readPort(process.argv.slice(2));
const vitePort = process.env.VITE_PORT || "5173";
const env = {
  ...process.env,
  NODE_ENV: process.env.NODE_ENV || "development",
  PORT: serverPort,
  VITE_SERVER_HOST:
    process.env.VITE_SERVER_HOST || `http://localhost:${serverPort}`,
};

const processes = [
  spawn("npx", ["tsx", "watch", "server/server.ts"], {
    stdio: "inherit",
    env,
    shell: process.platform === "win32",
  }),
  spawn("npx", ["vite", "--host", "0.0.0.0", "--port", vitePort], {
    stdio: "inherit",
    env,
    shell: process.platform === "win32",
  }),
];

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of processes) {
    if (!child.killed) {
      child.kill(process.platform === "win32" ? undefined : "SIGTERM");
    }
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

for (const child of processes) {
  child.on("exit", (code, signal) => {
    if (!shuttingDown && code !== 0) {
      console.error(`dev process exited with ${signal || code}`);
      shutdown(code ?? 1);
    }
  });
}

console.log(
  `Starting WatchParty dev server on http://localhost:${serverPort} and UI on http://localhost:${vitePort}`,
);

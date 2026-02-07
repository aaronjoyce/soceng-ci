#!/usr/bin/env node

import { program } from "commander";
import chalk from "chalk";
import { createTunnel, Tunnel } from "./client/tunnel";

program
  .name("soceng-tunnel")
  .description("Expose a local server via a tunnel")
  .version("1.0.0");

program
  .command("start-local-tunnel")
  .description("Start a tunnel to expose a local port")
  .requiredOption("-p, --port <port>", "Local port to expose", parseInt)
  .option("-l, --local-host <host>", "Local host to forward to", "localhost")
  .option("-s, --server-host <host>", "Tunnel server host", "abbreviated.ai")
  .option("--server-port <port>", "Tunnel server control port", (v: string) => parseInt(v), 443)
  .option("--local", "Connect to local tunnel server (localhost:9000) instead of remote", false)
  .option("--subdomain <subdomain>", "Request a specific subdomain")
  .option("-t, --api-token <token>", "API token for authentication")
  .option("--local-https", "Use HTTPS for local connections", false)
  .option("--print-requests", "Print incoming requests", false)
  .action(async (options) => {
    const serverHost = options.local ? "localhost" : options.serverHost;
    const serverPort = options.local ? 9000 : options.serverPort;

    console.log(chalk.blue("Starting local tunnel..."));
    console.log(chalk.gray(`  Local server: ${options.localHost}:${options.port}`));
    console.log(chalk.gray(`  Tunnel server: ${serverHost}:${serverPort}`));

    let tunnel: Tunnel | null = null;

    try {
      tunnel = await createTunnel({
        port: options.port,
        localHost: options.localHost,
        serverHost,
        serverPort,
        apiPort: options.local ? 8081 : serverPort,
        subdomain: options.subdomain,
        apiToken: options.apiToken,
        localHttps: options.localHttps,
        printRequests: options.printRequests,
      });

      console.log(chalk.green("\nTunnel is open!"));
      console.log(chalk.bold(`  Public URL: ${tunnel.url}`));
      console.log(chalk.gray(`  Tunnel ID: ${tunnel.tunnelId}`));
      console.log(chalk.gray("\nPress Ctrl+C to close the tunnel\n"));

      if (options.printRequests) {
        tunnel.on("request", (info) => {
          console.log(
            chalk.cyan(`[${new Date().toISOString()}]`),
            chalk.yellow(info.method),
            info.path
          );
        });
      }

      tunnel.on("error", (err) => {
        console.error(chalk.red("Tunnel error:"), err.message);
      });

      tunnel.on("close", () => {
        console.log(chalk.yellow("\nTunnel closed"));
        process.exit(0);
      });

      tunnel.on("tunnel_done", (payload) => {
        console.log(chalk.green("\nServer signalled tunnel_done"));
        if (payload.data) {
          console.log(chalk.gray(`  Data: ${JSON.stringify(payload.data)}`));
        }
      });

      // Handle graceful shutdown
      process.on("SIGINT", () => {
        console.log(chalk.yellow("\nClosing tunnel..."));
        if (tunnel) {
          tunnel.close();
        }
        process.exit(0);
      });

      // Keep the process alive
      await new Promise(() => {});
    } catch (error) {
      const msg = (error as Error).message;
      console.error(chalk.red("\nFailed to start tunnel:"), msg);

      if (msg.includes("Local server")) {
        console.log(chalk.yellow("\nMake sure your local server is running on port"), chalk.bold(options.port));
      } else if (msg.includes("connection refused") || msg.includes("not running")) {
        console.log(chalk.yellow("\nMake sure the tunnel server is running:"));
        console.log(chalk.gray("  npm run start-server"));
      } else if (msg.includes("could not be resolved") || msg.includes("check your network")) {
        console.log(chalk.yellow("\nCheck your network connection and verify the server host is correct."));
      } else if (msg.includes("temporarily unavailable") || msg.includes("timed out") || msg.includes("not responding")) {
        console.log(chalk.yellow("\nThe tunnel service appears to be down. Try again in a few minutes."));
      }

      process.exit(1);
    }
  });

program
  .command("server")
  .description("Start the tunnel server (deprecated — use soceng-ci-tunnel-server)")
  .action(() => {
    console.log(chalk.yellow("The tunnel server has been moved to a standalone project."));
    console.log(chalk.gray("  cd ~/soceng-ci-tunnel-server && npm run dev"));
    process.exit(0);
  });

program.parse();

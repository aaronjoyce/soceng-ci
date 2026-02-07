import { EventEmitter } from "events";
import * as http from "http";
import * as https from "https";
import * as os from "os";
import WebSocket from "ws";
import { createWebSocketStream } from "ws";
import { Duplex } from "stream";
import { TunnelOptions, TunnelInfo, CreateTunnelResponse } from "../types";
import { TunnelHTTP2Handler } from "./tunnel-http2-handler";

const DEFAULT_SERVER_HOST = "abbreviated.ai";
const DEFAULT_SERVER_PORT = 443;

interface TunnelDonePayload {
  type: "tunnel_done";
  tunnel_id: string;
  data: Record<string, unknown> | null;
}

interface TunnelEvents {
  open: (info: { url: string }) => void;
  close: () => void;
  error: (error: Error) => void;
  request: (info: { method: string; path: string }) => void;
  tunnel_done: (payload: TunnelDonePayload) => void;
}

export class Tunnel extends EventEmitter {
  private readonly opts: Required<
    Pick<TunnelOptions, "port" | "localHost" | "serverHost" | "serverPort" | "apiPort">
  > &
    TunnelOptions;
  private closed = false;
  private h2Handler: TunnelHTTP2Handler | null = null;
  private wsConnections: WebSocket[] = [];
  private tunnelInfo: TunnelInfo | null = null;

  public url: string | null = null;
  public tunnelId: string | null = null;

  constructor(opts: TunnelOptions) {
    super();
    this.opts = {
      localHost: "localhost",
      serverHost: DEFAULT_SERVER_HOST,
      serverPort: DEFAULT_SERVER_PORT,
      ...opts,
      apiPort: opts.apiPort ?? opts.serverPort ?? DEFAULT_SERVER_PORT,
    };
  }

  private async checkLocalServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      const scheme = this.opts.localHttps ? "https" : "http";
      const req = (scheme === "https" ? https : http).request(
        { host: this.opts.localHost, port: this.opts.port, path: "/", method: "HEAD", timeout: 3000 },
        () => resolve()
      );
      req.on("timeout", () => {
        req.destroy();
        reject(new Error(`Local server at ${this.opts.localHost}:${this.opts.port} is not responding (timeout)`));
      });
      req.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "ECONNREFUSED") {
          reject(new Error(`Local server at ${this.opts.localHost}:${this.opts.port} is not running (connection refused)`));
        } else {
          reject(new Error(`Could not reach local server at ${this.opts.localHost}:${this.opts.port}: ${err.message}`));
        }
      });
      req.end();
    });
  }

  async open(): Promise<void> {
    try {
      // Step 1: Verify the local server is reachable before establishing a tunnel
      await this.checkLocalServer();

      // Step 2: Get tunnel info from server
      this.tunnelInfo = await this.getTunnelInfo();
      this.url = this.tunnelInfo.url;
      this.tunnelId = this.tunnelInfo.id;

      // Step 2: Connect to tunnel server via WebSocket + HTTP/2
      await this.connectToServer();

      this.emit("open", { url: this.url });
    } catch (error) {
      this.emit("error", error as Error);
      throw error;
    }
  }

  private async getTunnelInfo(): Promise<TunnelInfo> {
    return new Promise((resolve, reject) => {
      const apiPort = this.opts.apiPort;
      const scheme = apiPort === 443 ? "https" : "http";
      const portSuffix = (apiPort === 443 || apiPort === 80) ? "" : `:${apiPort}`;
      const url = `${scheme}://${this.opts.serverHost}${portSuffix}/api/v1/ci-tunnels/`;

      const queryParams = new URLSearchParams();
      if (this.opts.subdomain) {
        queryParams.set("subdomain", this.opts.subdomain);
      }

      const fullUrl = `${url}?${queryParams.toString()}`;

      const req = (scheme === "https" ? https : http).request(
        fullUrl,
        {
          method: "POST",
          timeout: 10000,
          headers: {
            "Content-Type": "application/json",
            ...(this.opts.apiToken
              ? { Authorization: `Bearer ${this.opts.apiToken}` }
              : {}),
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            if (res.statusCode !== 200) {
              const status = res.statusCode ?? 0;
              let reason: string;
              if (status === 503 || status === 502 || status === 504) {
                reason = `Tunnel server is temporarily unavailable (HTTP ${status})`;
              } else if (status === 401 || status === 403) {
                reason = `Authentication failed (HTTP ${status}) — check your API token`;
              } else if (status === 429) {
                reason = `Rate limited by tunnel server (HTTP 429) — try again later`;
              } else {
                // Strip HTML tags for a readable one-liner
                const plain = data.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
                reason = `HTTP ${status}${plain ? `: ${plain.slice(0, 120)}` : ""}`;
              }
              reject(new Error(`Failed to create tunnel: ${reason}`));
              return;
            }
            try {
              const response: CreateTunnelResponse = JSON.parse(data);
              // The server generates URLs using its internal scheme/port (http + 80).
              // Rewrite to match the scheme we actually connected with so the
              // displayed public URL is correct (e.g. https://id.abbreviated.ai).
              const parsedUrl = new URL(response.url);
              if (scheme === "https") {
                parsedUrl.protocol = "https:";
                if (parsedUrl.port === "80") parsedUrl.port = "";
              }
              resolve({
                id: response.tunnel_id,
                url: parsedUrl.toString(),
                remoteHost: this.opts.serverHost,
                remotePort: this.opts.serverPort,
              });
            } catch (e) {
              reject(new Error(`Failed to parse tunnel response: ${data}`));
            }
          });
        }
      );

      req.on("timeout", () => {
        req.destroy();
        reject(new Error(`Tunnel server at ${this.opts.serverHost}:${apiPort} timed out`));
      });
      req.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "ECONNREFUSED") {
          reject(new Error(`Tunnel server at ${this.opts.serverHost}:${apiPort} is not running (connection refused)`));
        } else if (err.code === "ENOTFOUND") {
          reject(new Error(`Tunnel server host '${this.opts.serverHost}' could not be resolved — check your network connection`));
        } else if (err.code === "ETIMEDOUT" || err.message.includes("socket hang up")) {
          reject(new Error(`Tunnel server at ${this.opts.serverHost}:${apiPort} is not responding`));
        } else {
          reject(err);
        }
      });
      req.end();
    });
  }

  private async connectToServer(): Promise<void> {
    if (!this.tunnelInfo) {
      throw new Error("Tunnel info not available");
    }

    const { remoteHost, remotePort } = this.tunnelInfo;
    const tunnelId = this.tunnelInfo.id;
    const numConnections = Math.min(os.cpus().length, 16);
    const streams: Duplex[] = [];

    // Open N WebSocket connections for HTTP/2 multiplexing
    for (let i = 0; i < numConnections; i++) {
      const wsScheme = remotePort === 443 ? "wss" : "ws";
      const wsPortSuffix = (remotePort === 443 || remotePort === 80) ? "" : `:${remotePort}`;
      const ws = new WebSocket(
        `${wsScheme}://${remoteHost}${wsPortSuffix}/connect?tunnel_id=${tunnelId}`,
        {
          headers: {
            Authorization: `Bearer ${this.opts.apiToken}`,
          },
        }
      );

      await new Promise<void>((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", (err) => {
          reject(
            new Error(
              `WebSocket connection failed: ${err.message} (${remoteHost}:${remotePort})`
            )
          );
        });
      });

      // Create a Duplex stream from the WebSocket for HTTP/2
      const stream = createWebSocketStream(ws) as Duplex;

      // Add stub methods that Node's HTTP/2 implementation expects on sockets
      const s = stream as any;
      s.setNoDelay = () => s;
      s.setTimeout = () => s;
      s.setKeepAlive = () => s;
      s.ref = () => s;
      s.unref = () => s;
      s.encrypted = false;
      s.remoteAddress = remoteHost;
      s.remotePort = remotePort;

      ws.on("error", (err) => {
        if (!this.closed) {
          this.emit("error", err);
        }
      });

      ws.on("close", () => {
        if (!this.closed) {
          console.log(`WebSocket ${i + 1} closed`);
        }
      });

      // Listen for text messages from the server (e.g. tunnel_done signal).
      // Binary frames are consumed by the HTTP/2 Duplex stream; text messages
      // are control signals sent by the server outside the h2 framing.
      ws.on("message", (data, isBinary) => {
        if (isBinary || this.closed) return;
        try {
          const payload = JSON.parse(data.toString()) as TunnelDonePayload;
          if (payload.type === "tunnel_done") {
            this.emit("tunnel_done", payload);
            this.close();
          }
        } catch {
          // Not JSON or not a control message — ignore
        }
      });

      this.wsConnections.push(ws);
      streams.push(stream);
    }

    // Create HTTP/2 handler
    this.h2Handler = new TunnelHTTP2Handler({
      localHost: this.opts.localHost,
      localPort: this.opts.port,
      localHttps: this.opts.localHttps || false,
      streams,
    });

    this.h2Handler.on("request", (info) => {
      this.emit("request", info);
    });

    this.h2Handler.startListening();
  }

  close(): void {
    this.closed = true;
    if (this.h2Handler) {
      this.h2Handler.close();
      this.h2Handler = null;
    }
    for (const ws of this.wsConnections) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }
    this.wsConnections = [];
    this.emit("close");
  }
}

export async function createTunnel(opts: TunnelOptions): Promise<Tunnel> {
  const tunnel = new Tunnel(opts);
  await tunnel.open();
  return tunnel;
}

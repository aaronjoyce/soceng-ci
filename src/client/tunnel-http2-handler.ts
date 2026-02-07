import { EventEmitter } from "events";
import { request as httpRequest } from "http";
import { request as httpsRequest } from "https";
import { Duplex } from "stream";
import { createServer, Http2Server } from "http2";
import { pipeline } from "stream";
import WebSocket from "ws";

const HTTP2_WINDOW_SIZE = 1024 * 1024 * 32; // 32MB
const HTTP2_MAX_SESSION_MEMORY = 256; // MB

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
]);

export interface TunnelHTTP2HandlerOpts {
  localHost: string;
  localPort: number;
  localHttps: boolean;
  streams: Duplex[];
}

export class TunnelHTTP2Handler extends EventEmitter {
  private readonly opts: TunnelHTTP2HandlerOpts;
  private readonly server: Http2Server;

  constructor(opts: TunnelHTTP2HandlerOpts) {
    super();
    this.opts = opts;

    this.server = createServer({
      settings: {
        initialWindowSize: HTTP2_WINDOW_SIZE,
      },
      maxSessionMemory: HTTP2_MAX_SESSION_MEMORY,
    });

    this.server.on("session", (session) => {
      session.once("remoteSettings", () => {
        session.setLocalWindowSize(HTTP2_WINDOW_SIZE);
      });
    });
  }

  startListening(): void {
    this.server.on("request", (req, res) => {
      this.emit("request", {
        method: req.method ?? "unknown",
        path: req.url ?? "unknown",
      });

      // Check for WebSocket upgrade signal from the tunnel server
      if (req.headers["upgrade"] === "websocket") {
        this.handleWebSocketUpgrade(req, res);
        return;
      }

      this.handleHttpRequest(req, res);
    });

    // Feed each WebSocket-backed stream into the HTTP/2 server
    for (const stream of this.opts.streams) {
      this.server.emit("connection", stream);
      stream.resume();
    }
  }

  private handleHttpRequest(
    req: import("http2").Http2ServerRequest,
    res: import("http2").Http2ServerResponse
  ): void {
    // Filter pseudo-headers and hop-by-hop headers
    const headersToForward: Record<string, string | string[] | undefined> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (!key.startsWith(":") && !HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
        headersToForward[key] = value;
      }
    }
    delete headersToForward["host"];
    // Don't forward the upgrade header for normal requests
    delete headersToForward["upgrade"];

    const request = this.opts.localHttps ? httpsRequest : httpRequest;

    const clientReq = request(
      {
        hostname: this.opts.localHost,
        port: this.opts.localPort,
        path: req.url,
        method: req.method,
        headers: headersToForward,
      },
      (clientRes) => {
        // Filter response headers
        const responseHeaders: Record<string, string | string[] | undefined> = {};
        for (const [key, value] of Object.entries(clientRes.headers)) {
          if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
            responseHeaders[key] = value;
          }
        }

        res.writeHead(clientRes.statusCode || 502, responseHeaders);

        pipeline(clientRes, res, (err) => {
          if (err) {
            console.error("Response pipeline error:", err.message);
          }
        });
      }
    );

    pipeline(req, clientReq, (err) => {
      if (err) {
        console.error("Request pipeline error:", err.message);
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "text/plain" });
        }
        res.end("Bad Gateway");
      }
    });

    clientReq.on("error", (err) => {
      console.error("Local request error:", err.message);
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain" });
      }
      res.end(`Failed to connect to local server: ${err.message}`);
    });
  }

  private handleWebSocketUpgrade(
    req: import("http2").Http2ServerRequest,
    res: import("http2").Http2ServerResponse
  ): void {
    const protocol = this.opts.localHttps ? "wss" : "ws";
    const localWsUrl = `${protocol}://${this.opts.localHost}:${this.opts.localPort}${req.url}`;

    // Forward relevant headers to the local WebSocket
    const wsHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (
        !key.startsWith(":") &&
        !HOP_BY_HOP_HEADERS.has(key.toLowerCase()) &&
        key.toLowerCase() !== "host" &&
        key.toLowerCase() !== "upgrade"
      ) {
        wsHeaders[key] = String(value);
      }
    }

    const localWs = new WebSocket(localWsUrl, { headers: wsHeaders });

    localWs.on("open", () => {
      // Signal success back to the tunnel server
      res.writeHead(200);

      // Bidirectional forwarding: h2 stream <-> local WebSocket

      // h2 stream -> local WebSocket
      req.on("data", (chunk: Buffer) => {
        if (localWs.readyState === WebSocket.OPEN) {
          localWs.send(chunk);
        }
      });

      req.on("end", () => {
        if (localWs.readyState === WebSocket.OPEN) {
          localWs.close();
        }
      });

      // local WebSocket -> h2 stream
      localWs.on("message", (data: WebSocket.Data) => {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        if (!res.closed) {
          res.write(buf);
        }
      });

      localWs.on("close", () => {
        if (!res.closed) {
          res.end();
        }
      });
    });

    localWs.on("error", (err) => {
      console.error("Local WebSocket error:", err.message);
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain" });
      }
      res.end(`Failed to connect to local WebSocket: ${err.message}`);
    });
  }

  close(): void {
    this.server.close();
  }
}

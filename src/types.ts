export interface TunnelOptions {
  /** Local port to forward traffic to */
  port: number;
  /** Local host to forward traffic to (default: localhost) */
  localHost?: string;
  /** Tunnel server host */
  serverHost?: string;
  /** Tunnel server WebSocket port */
  serverPort?: number;
  /** Tunnel REST API port (defaults to serverPort; use when API and WebSocket are on different ports) */
  apiPort?: number;
  /** Request a specific subdomain */
  subdomain?: string;
  /** API token for authentication */
  apiToken?: string;
  /** Use HTTPS for local connections */
  localHttps?: boolean;
  /** Print incoming requests */
  printRequests?: boolean;
}

export interface TunnelInfo {
  /** Unique tunnel ID (subdomain string) */
  id: string;
  /** Public URL to access the tunnel */
  url: string;
  /** Remote host for WebSocket tunnel connection */
  remoteHost: string;
  /** Remote port for WebSocket tunnel connection */
  remotePort: number;
}

export interface CreateTunnelResponse {
  id: number;
  tunnel_id: string;
  url: string;
  created_at: string;
  connected_at: string | null;
  completed_at: string | null;
  playwright_result: string | null;
}

export interface IncomingRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: Buffer;
}

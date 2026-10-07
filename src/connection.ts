// A thin Chrome DevTools Protocol client over one transport.
//
// Deliberately not puppeteer: every domain enabled is a choice made by the caller.
// `Runtime.enable` in particular is a known automation tell — ODI's resolver never
// runs it inside a signup — and this client enables nothing on its own. Popups and
// iframes are reached by attaching to their targets with `flatten: true` and routing
// commands through the returned sessionId, exactly as ODI does.

import { type CdpTransport, WebSocketTransport } from "./transport";

export type CdpParams = Record<string, unknown>;
export type CdpHandler = (params: unknown, sessionId: string | undefined) => void;

export class CdpError extends Error {
  readonly method: string;
  readonly code: number;

  constructor(method: string, code: number, detail: string) {
    super(`${method}: ${detail} (CDP code ${code})`);
    this.method = method;
    this.code = code;
  }
}

type Pending = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type Inbound = {
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
  method?: string;
  params?: unknown;
  sessionId?: string;
};

const DEFAULT_TIMEOUT_MS = 10_000;

export class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly handlers = new Map<string, Set<CdpHandler>>();
  private readonly transport: CdpTransport;
  /**
   * Set once the transport closes. A closed connection never reopens — Chrome
   * is gone — so every later send is refused at once instead of waiting out a
   * ten-second timeout it can only lose.
   */
  private closed = false;

  private constructor(transport: CdpTransport) {
    this.transport = transport;
    transport.onMessage((raw) => this.onMessage(raw));
    transport.onClose(() => {
      this.closed = true;
      this.failAll(new Error("CDP connection closed"));
    });
  }

  // Wrap an already-open transport. The pipe path uses this; the WebSocket path
  // goes through `connect` below and is unchanged.
  static overTransport(transport: CdpTransport): CdpConnection {
    return new CdpConnection(transport);
  }

  static connect(wsUrl: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`CDP connect timed out: ${wsUrl}`));
      }, timeoutMs);
      ws.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve(new CdpConnection(new WebSocketTransport(ws)));
        },
        { once: true },
      );
      ws.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error(`CDP connect failed: ${wsUrl}`));
        },
        { once: true },
      );
    });
  }

  /** False once Chrome has gone: nothing driving this browser can recover. */
  isOpen(): boolean {
    return !this.closed;
  }

  send<T = unknown>(
    method: string,
    params: CdpParams = {},
    options: { sessionId?: string; timeoutMs?: number } = {},
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error("CDP connection closed"));
    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const message: Record<string, unknown> = { id, method, params };
    if (options.sessionId !== undefined) message["sessionId"] = options.sessionId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve: (v) => resolve(v as T), reject, timer });
      this.transport.send(JSON.stringify(message));
    });
  }

  // Subscribe to an event by method name; returns the unsubscribe function.
  on(method: string, handler: CdpHandler): () => void {
    let set = this.handlers.get(method);
    if (set === undefined) {
      set = new Set();
      this.handlers.set(method, set);
    }
    set.add(handler);
    return () => set.delete(handler);
  }

  async attach(targetId: string): Promise<CdpSession> {
    const { sessionId } = await this.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    return new CdpSession(this, sessionId, targetId);
  }

  close(): void {
    this.transport.close();
  }

  private onMessage(raw: string): void {
    const msg = JSON.parse(raw) as Inbound;
    if (msg.id !== undefined) {
      const pending = this.pending.get(msg.id);
      if (pending === undefined) return;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error !== undefined) {
        pending.reject(new CdpError(pending.method, msg.error.code, msg.error.message));
      } else pending.resolve(msg.result);
      return;
    }
    if (msg.method === undefined) return;
    const set = this.handlers.get(msg.method);
    if (set === undefined) return;
    for (const handler of set) handler(msg.params, msg.sessionId);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

// One attached target (a page, a popup, an OOPIF): the same connection, every
// command tagged with this session's id.
export class CdpSession {
  readonly connection: CdpConnection;
  readonly sessionId: string;
  readonly targetId: string;

  constructor(connection: CdpConnection, sessionId: string, targetId: string) {
    this.connection = connection;
    this.sessionId = sessionId;
    this.targetId = targetId;
  }

  send<T = unknown>(method: string, params: CdpParams = {}, timeoutMs?: number): Promise<T> {
    const options: { sessionId: string; timeoutMs?: number } = { sessionId: this.sessionId };
    if (timeoutMs !== undefined) options.timeoutMs = timeoutMs;
    return this.connection.send<T>(method, params, options);
  }

  on(method: string, handler: (params: unknown) => void): () => void {
    return this.connection.on(method, (params, sessionId) => {
      if (sessionId === this.sessionId) handler(params);
    });
  }

  detach(): Promise<unknown> {
    return this.connection.send("Target.detachFromTarget", { sessionId: this.sessionId });
  }
}

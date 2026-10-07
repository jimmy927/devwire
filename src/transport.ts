// How a CdpConnection's bytes get to Chrome. Two transports, one interface.
//
// The WebSocket is the original and stays the default: most consumers run over it,
// and nothing about it changes.
//
// The pipe exists for one reason. Branded Google Chrome refuses to load an
// unpacked extension from the command line — Chrome 144 logs
// "--load-extension is not allowed in Google Chrome, ignoring" — and the only
// way to install one without leaving branded Chrome is the `Extensions` CDP
// domain, which is served ONLY over `--remote-debugging-pipe`. Asked for it
// over a port, Chrome answers "Method not available".
//
// Branded Chrome is not negotiable here: the laptop's Windows chrome.exe and the
// box's Linux Chrome with EGL are what pass Cloudflare, and Chromium with
// software GL never did.

export interface CdpTransport {
  send(raw: string): void;
  onMessage(handler: (raw: string) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}

export class WebSocketTransport implements CdpTransport {
  private readonly ws: WebSocket;

  constructor(ws: WebSocket) {
    this.ws = ws;
  }

  send(raw: string): void {
    this.ws.send(raw);
  }

  onMessage(handler: (raw: string) => void): void {
    this.ws.addEventListener("message", (event) => handler(String(event.data)));
  }

  onClose(handler: () => void): void {
    this.ws.addEventListener("close", () => handler());
  }

  close(): void {
    this.ws.close();
  }
}

// The two halves of Chrome's `--remote-debugging-pipe`: it reads commands from
// its own fd 3 and writes replies to its own fd 4, so the parent writes to the
// first and reads from the second.
export type PipeStreams = {
  toChrome: { write(chunk: string): unknown };
  fromChrome: { on(event: "data", listener: (chunk: Uint8Array) => void): unknown };
};

// Messages on the pipe are NUL-delimited JSON, not framed like a WebSocket, so
// a read can split one message or carry three. The buffer below is the whole
// difference between the two transports.
const NUL = 0;

export class PipeTransport implements CdpTransport {
  private buffer = new Uint8Array(0);
  private messageHandler: ((raw: string) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  private readonly decoder = new TextDecoder();
  private readonly streams: PipeStreams;

  constructor(streams: PipeStreams) {
    this.streams = streams;
    streams.fromChrome.on("data", (chunk) => this.onChunk(chunk));
  }

  send(raw: string): void {
    this.streams.toChrome.write(`${raw}\0`);
  }

  onMessage(handler: (raw: string) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  close(): void {
    this.closeHandler?.();
  }

  private onChunk(chunk: Uint8Array): void {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;
    for (;;) {
      const end = this.buffer.indexOf(NUL);
      if (end === -1) return;
      const raw = this.decoder.decode(this.buffer.subarray(0, end));
      this.buffer = this.buffer.subarray(end + 1);
      if (raw.length > 0) this.messageHandler?.(raw);
    }
  }
}

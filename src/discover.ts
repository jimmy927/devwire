// Find the browser-level DevTools WebSocket of a Chrome started with
// --remote-debugging-port, polling until the port answers.

export async function debuggerWsUrl(port: number, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const url = await tryVersion(port);
    if (url !== null) return url;
    if (Date.now() > deadline) {
      throw new Error(`Chrome did not open DevTools on port ${port} within ${timeoutMs}ms`);
    }
    await Bun.sleep(100);
  }
}

async function tryVersion(port: number): Promise<string | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`);
    if (!response.ok) return null;
    const body = (await response.json()) as { webSocketDebuggerUrl?: unknown };
    return typeof body.webSocketDebuggerUrl === "string" ? body.webSocketDebuggerUrl : null;
  } catch {
    return null; // not listening yet
  }
}

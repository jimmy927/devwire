import { expect, test } from "bun:test";
import { type PipeStreams, PipeTransport } from "./transport";

// A fake pipe: collects what would go to Chrome, and lets a test push bytes
// back the way Chrome would.
function fakePipe(): {
  streams: PipeStreams;
  written: string[];
  push: (bytes: string) => void;
  pushBytes: (bytes: Uint8Array) => void;
} {
  const written: string[] = [];
  let listener: ((chunk: Uint8Array) => void) | null = null;
  const pushBytes = (bytes: Uint8Array) => {
    if (listener !== null) listener(bytes);
  };
  return {
    written,
    push: (bytes: string) => pushBytes(new TextEncoder().encode(bytes)),
    pushBytes,
    streams: {
      toChrome: { write: (chunk: string) => written.push(chunk) },
      fromChrome: {
        on: (_e: "data", l: (chunk: Uint8Array) => void) => {
          listener = l;
        },
      },
    },
  };
}

test("a command is NUL-terminated on the way out", () => {
  const pipe = fakePipe();
  new PipeTransport(pipe.streams).send('{"id":1}');
  expect(pipe.written).toEqual(['{"id":1}\0']);
});

test("one read carrying several messages yields several messages", () => {
  // The whole difference from the WebSocket: the pipe is a byte stream, not a
  // framed one, so Chrome's writes and our reads do not line up.
  const pipe = fakePipe();
  const got: string[] = [];
  const transport = new PipeTransport(pipe.streams);
  transport.onMessage((raw) => got.push(raw));
  pipe.push('{"id":1}\0{"id":2}\0{"id":3}\0');
  expect(got).toEqual(['{"id":1}', '{"id":2}', '{"id":3}']);
});

test("a message split across reads is reassembled", () => {
  const pipe = fakePipe();
  const got: string[] = [];
  const transport = new PipeTransport(pipe.streams);
  transport.onMessage((raw) => got.push(raw));
  pipe.push('{"id":1,"result":{"a"');
  expect(got).toEqual([]);
  pipe.push(":1}}\0");
  expect(got).toEqual(['{"id":1,"result":{"a":1}}']);
});

test("a trailing partial message is held, not delivered", () => {
  const pipe = fakePipe();
  const got: string[] = [];
  const transport = new PipeTransport(pipe.streams);
  transport.onMessage((raw) => got.push(raw));
  pipe.push('{"id":1}\0{"id":2');
  expect(got).toEqual(['{"id":1}']);
});

test("multi-byte UTF-8 split across reads survives", () => {
  // A page title or a prompt in any non-ASCII locale lands here. Decoding each
  // read separately would cut a character in half, which is why the transport
  // buffers BYTES and decodes only once a whole message is in hand.
  const pipe = fakePipe();
  const got: string[] = [];
  const transport = new PipeTransport(pipe.streams);
  transport.onMessage((raw) => got.push(raw));

  const message = '{"t":"Was ist 4 + 7? \u2014 \u00fcbergro\u00df"}';
  const bytes = new TextEncoder().encode(`${message}\0`);
  // Cut inside the em dash, which is three bytes.
  const cut = 24;
  pipe.pushBytes(bytes.subarray(0, cut));
  expect(got).toEqual([]);
  pipe.pushBytes(bytes.subarray(cut));
  expect(got).toEqual([message]);
});

test("an empty stretch between NULs is ignored", () => {
  const pipe = fakePipe();
  const got: string[] = [];
  const transport = new PipeTransport(pipe.streams);
  transport.onMessage((raw) => got.push(raw));
  pipe.push('\0\0{"id":1}\0');
  expect(got).toEqual(['{"id":1}']);
});

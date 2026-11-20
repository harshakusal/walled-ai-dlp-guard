import type { Readable, Writable } from 'node:stream';

/** Chrome native messaging framing: uint32 length (native byte order = LE on x86/ARM) + UTF-8 JSON. */
export const MAX_FROM_HOST = 1024 * 1024; // Chrome rejects host->browser messages over 1 MB

export function encode(msg: unknown): Buffer<ArrayBufferLike> {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  if (body.length > MAX_FROM_HOST) throw new Error(`message too large (${body.length} bytes)`);
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

export class FrameDecoder {
  private buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  constructor(private readonly onMessage: (msg: unknown) => void, private readonly maxMessage = 128 * 1024 * 1024) {}

  push(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32LE(0);
      if (len > this.maxMessage) throw new Error(`incoming message too large (${len})`);
      if (this.buf.length < 4 + len) return;
      const body = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      this.onMessage(JSON.parse(body.toString('utf8')));
    }
  }
}

export function attach(input: Readable, output: Writable, onMessage: (msg: unknown) => void, onEnd: () => void) {
  const decoder = new FrameDecoder(onMessage);
  input.on('data', (c: Buffer) => decoder.push(c));
  input.on('end', onEnd);
  input.on('close', onEnd);
  return (msg: unknown) => output.write(encode(msg));
}

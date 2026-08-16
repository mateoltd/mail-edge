import { createServer, type Server, type TLSSocket } from "node:tls";

import { faultBoundaryCertificate, faultBoundaryPrivateKey } from "./test-certificate.js";

export type SmtpFaultBehavior =
  "accept" | "delay_final" | "final_reject" | "half_close" | "malformed_final" | "reset_after_body";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

const deferred = <T>(): Deferred<T> => {
  let resolver: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolver = resolve;
  });
  return { promise, resolve: (value) => resolver?.(value) };
};

/** Minimal real SMTPS peer that exposes exact DATA and final-response fault points. */
export class SmtpFaultServer {
  #behavior: SmtpFaultBehavior = "accept";
  #bodyObserved = deferred<number>();
  readonly #connections = new Set<TLSSocket>();
  #server: Server | undefined;
  #transactions = 0;

  get port(): number {
    const server = this.#server;
    if (server === undefined) throw new Error("SMTP fault server is not started.");
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("SMTP fault server address is unavailable.");
    }
    return address.port;
  }

  get transactionCount(): number {
    return this.#transactions;
  }

  async start(): Promise<void> {
    if (this.#server !== undefined) throw new Error("SMTP fault server is already started.");
    const server = createServer(
      { cert: faultBoundaryCertificate, key: faultBoundaryPrivateKey, minVersion: "TLSv1.2" },
      (socket) => {
        this.#accept(socket);
      },
    );
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (server === undefined) return;
    for (const connection of this.#connections) connection.destroy();
    await new Promise<void>((resolve, reject) => {
      server.close((cause) => {
        if (cause === undefined) resolve();
        else reject(cause);
      });
    });
  }

  prepare(behavior: SmtpFaultBehavior): void {
    this.#behavior = behavior;
    this.#bodyObserved = deferred<number>();
  }

  waitForBody(): Promise<number> {
    return this.#bodyObserved.promise;
  }

  #accept(socket: TLSSocket): void {
    this.#connections.add(socket);
    socket.once("close", () => this.#connections.delete(socket));
    socket.on("error", () => {
      // Peer faults are expected evidence in this qualification server.
    });
    let buffer = Buffer.alloc(0);
    let inData = false;
    let observed = 0;
    socket.write("220 fault-boundary.test ESMTP\r\n");
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (inData) {
        const terminator = buffer.indexOf("\r\n.\r\n");
        const emptyTerminator = buffer.indexOf(".\r\n");
        const atStart = emptyTerminator === 0;
        if (terminator < 0 && !atStart) {
          const retained = Math.min(4, buffer.byteLength);
          observed += buffer.byteLength - retained;
          if (observed > 0) this.#bodyObserved.resolve(observed);
          buffer = buffer.subarray(buffer.byteLength - retained);
          if (this.#behavior === "reset_after_body") socket.destroy();
          return;
        }
        observed += atStart ? 0 : terminator + 2;
        this.#bodyObserved.resolve(observed);
        this.#transactions += 1;
        buffer = buffer.subarray(atStart ? 3 : terminator + 5);
        inData = false;
        switch (this.#behavior) {
          case "accept":
            socket.write("250 2.0.0 accepted 0198b22a-4c00-7000-8000-000000000099\r\n");
            break;
          case "delay_final":
            break;
          case "final_reject":
            socket.write("550 5.7.1 transaction rejected\r\n");
            break;
          case "half_close":
            socket.end();
            break;
          case "malformed_final":
            socket.end("not-an-smtp-response\r\n");
            break;
          case "reset_after_body":
            socket.destroy();
            break;
        }
        if (socket.destroyed) return;
      }
      while (!inData) {
        const end = buffer.indexOf("\r\n");
        if (end < 0) return;
        const command = buffer.subarray(0, end).toString("utf8");
        buffer = buffer.subarray(end + 2);
        if (command.startsWith("EHLO ")) {
          socket.write("250-fault-boundary.test\r\n250-AUTH PLAIN\r\n250 SIZE 26214400\r\n");
        } else if (command.startsWith("AUTH PLAIN ")) socket.write("235 2.7.0 authenticated\r\n");
        else if (command.startsWith("MAIL FROM:")) socket.write("250 2.1.0 sender accepted\r\n");
        else if (command.startsWith("RCPT TO:")) socket.write("250 2.1.5 recipient accepted\r\n");
        else if (command === "DATA") {
          socket.write("354 send message\r\n");
          inData = true;
        } else socket.write("500 5.5.2 command invalid\r\n");
      }
    });
  }
}

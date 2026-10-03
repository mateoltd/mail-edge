import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readdir, stat, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

import {
  SECTION_16_7_SHARD_COUNT,
  SECTION_16_7_TOTAL_RECORDS,
  type Section167IntegrityMeasurement,
} from "./production-scale.schema.js";

interface JournalEntry {
  readonly bytes: number;
  readonly digestSha256: string;
  readonly offset: number;
  readonly ordinal: number;
}

const maximumJournalLineBytes = 512;
const maximumJournalBytesPerShard =
  Math.ceil(SECTION_16_7_TOTAL_RECORDS / SECTION_16_7_SHARD_COUNT) * maximumJournalLineBytes;
const integrityBufferBytes = 1024 * 1024;

const isNodeError = (value: unknown): value is NodeJS.ErrnoException => value instanceof Error;

const openWritable = async (path: string, signal: AbortSignal): Promise<FileHandle> => {
  signal.throwIfAborted();
  try {
    return await open(path, "r+");
  } catch (cause) {
    if (!isNodeError(cause) || cause.code !== "ENOENT") throw cause;
    return open(path, "wx+");
  }
};

const parseJournalEntry = (line: string, expectedOffset: number): JournalEntry => {
  if (Buffer.byteLength(line, "utf8") > maximumJournalLineBytes)
    throw new TypeError("Durable journal line exceeded its bound.");
  const value: unknown = JSON.parse(line);
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).toSorted().join(",") !== "bytes,digestSha256,offset,ordinal"
  )
    throw new TypeError("Durable journal entry schema is invalid.");
  const record = value as Readonly<Record<string, unknown>>;
  const entry: JournalEntry = Object.freeze({
    bytes: Number(record["bytes"]),
    digestSha256: String(record["digestSha256"]),
    offset: Number(record["offset"]),
    ordinal: Number(record["ordinal"]),
  });
  if (
    !Number.isSafeInteger(entry.bytes) ||
    entry.bytes < 1 ||
    !/^[a-f0-9]{64}$/u.test(entry.digestSha256) ||
    !Number.isSafeInteger(entry.offset) ||
    entry.offset !== expectedOffset ||
    !Number.isSafeInteger(entry.ordinal) ||
    entry.ordinal < 0 ||
    entry.ordinal >= SECTION_16_7_TOTAL_RECORDS
  )
    throw new TypeError("Durable journal entry fields are invalid.");
  return entry;
};

const truncateIncompleteJournal = async (
  journal: FileHandle,
  signal: AbortSignal,
): Promise<number> => {
  signal.throwIfAborted();
  const { size } = await journal.stat();
  if (size > maximumJournalBytesPerShard)
    throw new Error("Durable journal exceeded its exact-scale byte bound.");
  if (size === 0) return 0;
  const tailBytes = Math.min(size, maximumJournalLineBytes);
  const tail = Buffer.alloc(tailBytes);
  const result = await journal.read(tail, 0, tailBytes, size - tailBytes);
  if (result.bytesRead !== tailBytes) throw new Error("Durable journal tail read was short.");
  if (tail[tail.byteLength - 1] === 0x0a) return size;
  const newline = tail.lastIndexOf(0x0a);
  if (newline < 0 && size > maximumJournalLineBytes)
    throw new Error("Durable journal has an unbounded incomplete line.");
  const completeBytes = newline < 0 ? 0 : size - tailBytes + newline + 1;
  await journal.truncate(completeBytes);
  return completeBytes;
};

const writeAll = async (
  handle: FileHandle,
  value: Uint8Array,
  position: number,
  signal: AbortSignal,
): Promise<void> => {
  let written = 0;
  while (written < value.byteLength) {
    signal.throwIfAborted();
    const result = await handle.write(
      value,
      written,
      value.byteLength - written,
      position + written,
    );
    signal.throwIfAborted();
    if (result.bytesWritten < 1) throw new Error("Durable write made no progress.");
    written += result.bytesWritten;
  }
};

class DurableShardRepository {
  readonly #data: FileHandle;
  #dataBytes: number;
  readonly #journal: FileHandle;
  #journalBytes: number;
  #records: number;
  readonly recoveredBytes: number;

  private constructor(input: {
    readonly data: FileHandle;
    readonly dataBytes: number;
    readonly journal: FileHandle;
    readonly journalBytes: number;
    readonly records: number;
    readonly recoveredBytes: number;
  }) {
    this.#data = input.data;
    this.#dataBytes = input.dataBytes;
    this.#journal = input.journal;
    this.#journalBytes = input.journalBytes;
    this.#records = input.records;
    this.recoveredBytes = input.recoveredBytes;
  }

  get bytes(): number {
    return this.#dataBytes;
  }

  get records(): number {
    return this.#records;
  }

  static async open(
    directory: string,
    shard: number,
    ordinals: Uint8Array,
    signal: AbortSignal,
  ): Promise<DurableShardRepository> {
    signal.throwIfAborted();
    const suffix = String(shard).padStart(2, "0");
    const dataPath = join(directory, `raw-${suffix}.bin`);
    const journalPath = join(directory, `raw-${suffix}.journal`);
    const [data, journal] = await Promise.all([
      openWritable(dataPath, signal),
      openWritable(journalPath, signal),
    ]);
    try {
      const journalBytes = await truncateIncompleteJournal(journal, signal);
      let expectedOffset = 0;
      let records = 0;
      if (journalBytes > 0) {
        const input = createReadStream(journalPath, {
          end: journalBytes - 1,
          highWaterMark: 64 * 1024,
        });
        const lines = createInterface({ crlfDelay: Infinity, input });
        try {
          for await (const line of lines) {
            signal.throwIfAborted();
            if (line.length === 0) continue;
            const entry = parseJournalEntry(line, expectedOffset);
            if (entry.ordinal % SECTION_16_7_SHARD_COUNT !== shard)
              throw new Error("Durable journal entry is in the wrong shard.");
            if (ordinals[entry.ordinal] !== 0)
              throw new Error("Durable message ordinal is duplicated.");
            ordinals[entry.ordinal] = 1;
            expectedOffset += entry.bytes;
            records += 1;
          }
        } finally {
          lines.close();
          input.destroy();
        }
      }
      const dataStat = await data.stat();
      if (dataStat.size < expectedOffset)
        throw new Error("Durable data is shorter than its committed journal.");
      const recoveredBytes = dataStat.size - expectedOffset;
      if (recoveredBytes > 0) await data.truncate(expectedOffset);
      return new DurableShardRepository({
        data,
        dataBytes: expectedOffset,
        journal,
        journalBytes,
        records,
        recoveredBytes,
      });
    } catch (cause) {
      await Promise.allSettled([data.close(), journal.close()]);
      throw cause;
    }
  }

  async commit(
    ordinal: number,
    body: AsyncIterable<Uint8Array>,
    expectedBytes: number,
    signal: AbortSignal,
  ): Promise<JournalEntry> {
    signal.throwIfAborted();
    const offset = this.#dataBytes;
    const digest = createHash("sha256");
    let bytes = 0;
    try {
      for await (const value of body) {
        signal.throwIfAborted();
        if (!(value instanceof Uint8Array)) throw new TypeError("Ingress yielded non-byte data.");
        const nextBytes = bytes + value.byteLength;
        if (nextBytes > expectedBytes) throw new RangeError("Ingress exceeded its declared size.");
        digest.update(value);
        await writeAll(this.#data, value, offset + bytes, signal);
        bytes = nextBytes;
      }
      if (bytes !== expectedBytes)
        throw new Error("Ingress did not match its exact declared size.");
      await this.#data.datasync();
      signal.throwIfAborted();
      const entry: JournalEntry = Object.freeze({
        bytes,
        digestSha256: digest.digest("hex"),
        offset,
        ordinal,
      });
      const encoded = Buffer.from(`${JSON.stringify(entry)}\n`, "utf8");
      if (encoded.byteLength > maximumJournalLineBytes)
        throw new Error("Encoded durable journal entry exceeded its bound.");
      await writeAll(this.#journal, encoded, this.#journalBytes, signal);
      await this.#journal.datasync();
      signal.throwIfAborted();
      this.#journalBytes += encoded.byteLength;
      this.#dataBytes += bytes;
      this.#records += 1;
      return entry;
    } catch (cause) {
      await this.#data.truncate(offset).catch(() => undefined);
      throw cause;
    }
  }

  async appendUncommitted(bytes: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const block = Buffer.alloc(Math.min(bytes, 64 * 1024), 0xa5);
    let written = 0;
    while (written < bytes) {
      const length = Math.min(block.byteLength, bytes - written);
      await writeAll(this.#data, block.subarray(0, length), this.#dataBytes + written, signal);
      written += length;
    }
    await this.#data.datasync();
    signal.throwIfAborted();
  }

  async verify(journalPath: string, signal: AbortSignal): Promise<Section167IntegrityMeasurement> {
    signal.throwIfAborted();
    const input = createReadStream(journalPath, { highWaterMark: 64 * 1024 });
    const lines = createInterface({ crlfDelay: Infinity, input });
    const buffer = Buffer.alloc(integrityBufferBytes);
    let bytesVerified = 0;
    let digestMismatches = 0;
    let recordsVerified = 0;
    let expectedOffset = 0;
    try {
      for await (const line of lines) {
        signal.throwIfAborted();
        if (line.length === 0) continue;
        const entry = parseJournalEntry(line, expectedOffset);
        const digest = createHash("sha256");
        let read = 0;
        while (read < entry.bytes) {
          signal.throwIfAborted();
          const length = Math.min(buffer.byteLength, entry.bytes - read);
          const result = await this.#data.read(buffer, 0, length, entry.offset + read);
          signal.throwIfAborted();
          if (result.bytesRead !== length)
            throw new Error("Integrity reread was unexpectedly short.");
          digest.update(buffer.subarray(0, length));
          read += length;
        }
        expectedOffset += entry.bytes;
        bytesVerified += read;
        recordsVerified += 1;
        if (digest.digest("hex") !== entry.digestSha256) digestMismatches += 1;
      }
    } finally {
      lines.close();
      input.destroy();
    }
    return Object.freeze({ bytesVerified, digestMismatches, recordsVerified });
  }

  async close(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await this.#journal.close();
    await this.#data.close();
  }
}

/** Owns sharded durable files and serializes commits within each append-only shard. */
export class DurableScaleRepository {
  readonly #directory: string;
  readonly #ordinals = new Uint8Array(SECTION_16_7_TOTAL_RECORDS);
  #shards: DurableShardRepository[] = [];
  #tails: Promise<void>[] = [];
  recoveredBytes = 0;

  constructor(directory: string) {
    if (directory.length === 0) throw new TypeError("Durable storage directory is required.");
    this.#directory = directory;
  }

  async start(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.#shards.length > 0) throw new Error("Durable repository is already started.");
    const names = await readdir(this.#directory);
    if (names.some((name) => !/^raw-\d{2}\.(?:bin|journal)$/u.test(name)))
      throw new Error("Durable storage directory contains an unexpected entry.");
    const shards: DurableShardRepository[] = [];
    try {
      for (let shard = 0; shard < SECTION_16_7_SHARD_COUNT; shard += 1)
        shards.push(
          await DurableShardRepository.open(this.#directory, shard, this.#ordinals, signal),
        );
    } catch (cause) {
      const cleanup = AbortSignal.timeout(30_000);
      await Promise.allSettled(shards.toReversed().map((shard) => shard.close(cleanup)));
      throw cause;
    }
    this.#shards = shards;
    this.#tails = Array.from({ length: SECTION_16_7_SHARD_COUNT }, () => Promise.resolve());
    this.recoveredBytes = shards.reduce((sum, shard) => sum + shard.recoveredBytes, 0);
  }

  async commit(
    ordinal: number,
    body: AsyncIterable<Uint8Array>,
    expectedBytes: number,
    signal: AbortSignal,
  ): Promise<JournalEntry> {
    signal.throwIfAborted();
    if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= SECTION_16_7_TOTAL_RECORDS)
      throw new RangeError("Message ordinal is invalid.");
    if (this.#ordinals[ordinal] !== 0) throw new Error("Message ordinal is already committed.");
    const shardIndex = ordinal % SECTION_16_7_SHARD_COUNT;
    const shard = this.#shards[shardIndex];
    const previous = this.#tails[shardIndex];
    if (shard === undefined || previous === undefined)
      throw new Error("Durable repository is not started.");
    this.#ordinals[ordinal] = 2;
    const operation = previous.then(() => shard.commit(ordinal, body, expectedBytes, signal));
    this.#tails[shardIndex] = operation.then(
      () => undefined,
      () => undefined,
    );
    try {
      const entry = await operation;
      this.#ordinals[ordinal] = 1;
      return entry;
    } catch (cause) {
      this.#ordinals[ordinal] = 0;
      throw cause;
    }
  }

  async appendUncommittedRecoveryProbe(bytes: number, signal: AbortSignal): Promise<void> {
    const shard = this.#shards[0];
    if (shard === undefined) throw new Error("Recovery probe shard is unavailable.");
    await shard.appendUncommitted(bytes, signal);
  }

  snapshot(): { readonly bytes: number; readonly records: number } {
    return Object.freeze({
      bytes: this.#shards.reduce((sum, shard) => sum + shard.bytes, 0),
      records: this.#shards.reduce((sum, shard) => sum + shard.records, 0),
    });
  }

  async verifyIntegrity(signal: AbortSignal): Promise<Section167IntegrityMeasurement> {
    const aggregate = { bytesVerified: 0, digestMismatches: 0, recordsVerified: 0 };
    for (let shard = 0; shard < this.#shards.length; shard += 1) {
      signal.throwIfAborted();
      const repository = this.#shards[shard];
      if (repository === undefined) throw new Error("Integrity shard is unavailable.");
      const result = await repository.verify(
        join(this.#directory, `raw-${String(shard).padStart(2, "0")}.journal`),
        signal,
      );
      aggregate.bytesVerified += result.bytesVerified;
      aggregate.digestMismatches += result.digestMismatches;
      aggregate.recordsVerified += result.recordsVerified;
    }
    return Object.freeze(aggregate);
  }

  async close(signal: AbortSignal): Promise<void> {
    const shards = this.#shards;
    this.#shards = [];
    await Promise.all(this.#tails);
    this.#tails = [];
    for (const shard of shards.toReversed()) await shard.close(signal);
  }
}

/** Fresh-process, read-only full digest verification for committed production evidence. */
export const verifyDurableScaleStorageReadOnly = async (
  directory: string,
  signal: AbortSignal,
): Promise<Section167IntegrityMeasurement> => {
  signal.throwIfAborted();
  const expectedNames = Array.from({ length: SECTION_16_7_SHARD_COUNT }, (_unused, shard) => {
    const suffix = String(shard).padStart(2, "0");
    return [`raw-${suffix}.bin`, `raw-${suffix}.journal`] as const;
  })
    .flat()
    .toSorted();
  const names = (await readdir(directory)).toSorted();
  if (
    names.length !== expectedNames.length ||
    names.some((name, index) => name !== expectedNames[index])
  )
    throw new Error("Read-only durable storage inventory is not exact.");
  const ordinals = new Uint8Array(SECTION_16_7_TOTAL_RECORDS);
  const aggregate = { bytesVerified: 0, digestMismatches: 0, recordsVerified: 0 };
  for (let shard = 0; shard < SECTION_16_7_SHARD_COUNT; shard += 1) {
    signal.throwIfAborted();
    const suffix = String(shard).padStart(2, "0");
    const dataPath = join(directory, `raw-${suffix}.bin`);
    const journalPath = join(directory, `raw-${suffix}.journal`);
    const boundedJournalSize = await stat(journalPath);
    if (boundedJournalSize.size > maximumJournalBytesPerShard)
      throw new Error("Read-only durable journal exceeded its exact-scale byte bound.");
    const data = await open(dataPath, "r");
    const input = createReadStream(journalPath, { highWaterMark: 64 * 1024 });
    const lines = createInterface({ crlfDelay: Infinity, input });
    const buffer = Buffer.alloc(integrityBufferBytes);
    let expectedOffset = 0;
    try {
      for await (const line of lines) {
        signal.throwIfAborted();
        if (line.length === 0) continue;
        const entry = parseJournalEntry(line, expectedOffset);
        if (entry.ordinal % SECTION_16_7_SHARD_COUNT !== shard)
          throw new Error("Read-only durable journal entry is in the wrong shard.");
        if (ordinals[entry.ordinal] !== 0)
          throw new Error("Read-only durable journal contains a duplicate ordinal.");
        ordinals[entry.ordinal] = 1;
        const digest = createHash("sha256");
        let read = 0;
        while (read < entry.bytes) {
          signal.throwIfAborted();
          const length = Math.min(buffer.byteLength, entry.bytes - read);
          const result = await data.read(buffer, 0, length, entry.offset + read);
          signal.throwIfAborted();
          if (result.bytesRead !== length)
            throw new Error("Read-only durable integrity read was short.");
          digest.update(buffer.subarray(0, length));
          read += length;
        }
        expectedOffset += entry.bytes;
        aggregate.bytesVerified += read;
        aggregate.recordsVerified += 1;
        if (digest.digest("hex") !== entry.digestSha256) aggregate.digestMismatches += 1;
      }
      const dataSize = (await data.stat()).size;
      if (dataSize !== expectedOffset)
        throw new Error("Read-only durable data has committed-tail drift.");
    } finally {
      lines.close();
      input.destroy();
      await data.close();
    }
  }
  if (ordinals.some((value) => value !== 1))
    throw new Error("Read-only durable storage is missing a required ordinal.");
  return Object.freeze(aggregate);
};

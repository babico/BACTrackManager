// NOTE(RN): node:crypto does not exist in the React Native runtime.
// At native integration, swap sealRow/openRow internals for
// react-native-get-random-values + a native AES-GCM module.
// The Journal/JournalBackend interfaces stay unchanged.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface JournalBackend {
  append(row: string): Promise<void>;
  readAll(): Promise<string[]>;
  replaceAll(rows: string[]): Promise<void>;
}

export interface JournalEntry {
  seq: number;
  at: string;
  kind: string;
  payload: Record<string, unknown>;
}

export class Journal {
  constructor(private readonly backend: JournalBackend, private readonly keyHex: string) {}

  async append(kind: string, payload: Record<string, unknown>): Promise<JournalEntry> {
    const existing = await this.read();
    const entry: JournalEntry = { seq: existing.length + 1, at: new Date().toISOString(), kind, payload };
    await this.backend.append(sealRow(this.keyHex, entry));
    return entry;
  }

  async read(): Promise<JournalEntry[]> {
    const rows = await this.backend.readAll();
    return rows.map((r) => openRow(this.keyHex, r));
  }

  async markSyncedThrough(seq: number): Promise<void> {
    const rest = (await this.read()).filter((e) => e.seq > seq);
    await this.backend.replaceAll(rest.map((e) => sealRow(this.keyHex, e)));
  }
}

function sealRow(keyHex: string, entry: JournalEntry): string {
  const key = Buffer.from(keyHex, "hex");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(entry), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

function openRow(keyHex: string, row: string): JournalEntry {
  const key = Buffer.from(keyHex, "hex");
  const raw = Buffer.from(row, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  const pt = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  return JSON.parse(pt) as JournalEntry;
}

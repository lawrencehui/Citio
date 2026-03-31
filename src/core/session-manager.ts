import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";

type ProviderName = "claude" | "codex";
const GLOBAL_SESSION_KEY = "__provider_session__";

interface SessionRecord {
  provider: ProviderName;
  sessionId: string;
  runtimeId: string;
  updatedAt: string;
}

export class SessionManager {
  private readonly provider: ProviderName;
  private readonly runtimeId: string;
  private readonly storagePath: string;
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(provider: ProviderName, memoryPath: string, runtimeId: string) {
    this.provider = provider;
    this.runtimeId = runtimeId;
    this.storagePath = path.join(memoryPath, "sessions.json");
    this.load();
  }

  get(threadKey: string): string | null {
    const exactRecord = this.sessions.get(threadKey);
    if (this.isUsableRecord(exactRecord)) {
      return exactRecord.sessionId;
    }

    const globalRecord = this.sessions.get(GLOBAL_SESSION_KEY);
    if (this.isUsableRecord(globalRecord)) {
      return globalRecord.sessionId;
    }

    let latestRecord: SessionRecord | null = null;
    for (const [key, record] of this.sessions.entries()) {
      if (key === GLOBAL_SESSION_KEY || !this.isUsableRecord(record)) {
        continue;
      }

      if (!latestRecord || record.updatedAt > latestRecord.updatedAt) {
        latestRecord = record;
      }
    }

    return latestRecord?.sessionId || null;
  }

  remember(threadKey: string, sessionId: string): void {
    const record = {
      provider: this.provider,
      sessionId,
      runtimeId: this.runtimeId,
      updatedAt: new Date().toISOString(),
    };

    this.sessions.set(GLOBAL_SESSION_KEY, record);
    this.sessions.set(threadKey, record);
    this.persist();
  }

  private load(): void {
    if (!existsSync(this.storagePath)) {
      return;
    }

    try {
      const raw = JSON.parse(readFileSync(this.storagePath, "utf-8")) as Record<string, SessionRecord>;
      for (const [threadKey, record] of Object.entries(raw)) {
        if (record?.provider && record.sessionId) {
          this.sessions.set(threadKey, record);
        }
      }
    } catch (err) {
      console.log(JSON.stringify({
        type: "session_store_load_failed",
        path: this.storagePath,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  private persist(): void {
    mkdirSync(path.dirname(this.storagePath), { recursive: true });

    const raw = Object.fromEntries(this.sessions.entries());
    writeFileSync(this.storagePath, JSON.stringify(raw, null, 2), "utf-8");
  }

  private isUsableRecord(record: SessionRecord | null | undefined): record is SessionRecord {
    return Boolean(
      record &&
      record.provider === this.provider &&
      record.sessionId &&
      record.runtimeId === this.runtimeId
    );
  }
}

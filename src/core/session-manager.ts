import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";

type ProviderName = "claude" | "codex";

interface SessionRecord {
  provider: ProviderName;
  sessionId: string;
  updatedAt: string;
}

export class SessionManager {
  private readonly provider: ProviderName;
  private readonly storagePath: string;
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(provider: ProviderName, memoryPath: string) {
    this.provider = provider;
    this.storagePath = path.join(memoryPath, "sessions.json");
    this.load();
  }

  get(threadKey: string): string | null {
    const record = this.sessions.get(threadKey);
    if (!record || record.provider !== this.provider) {
      return null;
    }

    return record.sessionId;
  }

  remember(threadKey: string, sessionId: string): void {
    this.sessions.set(threadKey, {
      provider: this.provider,
      sessionId,
      updatedAt: new Date().toISOString(),
    });
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
}

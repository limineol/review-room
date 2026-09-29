import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { runSchema, type Run, type Start } from "./schema";

export class Store {
  private db: Database;
  constructor(
    path = join(homedir(), ".local/share/review-room/reviews.sqlite"),
  ) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true });
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, config TEXT NOT NULL, status TEXT NOT NULL, fingerprint TEXT NOT NULL, created TEXT NOT NULL, owner INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, run TEXT NOT NULL, speaker TEXT NOT NULL, round INTEGER NOT NULL, text TEXT NOT NULL, time TEXT NOT NULL);",
    );
  }
  create(config: Start, fingerprint: string) {
    const id = crypto.randomUUID();
    this.db
      .query("INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?)")
      .run(
        id,
        JSON.stringify(config),
        "running",
        fingerprint,
        new Date().toISOString(),
        process.pid,
      );
    return id;
  }
  message(id: string, speaker: string, round: number, text: string) {
    this.db
      .query(
        "INSERT INTO messages (run,speaker,round,text,time) VALUES (?,?,?,?,?)",
      )
      .run(id, speaker, round, text, new Date().toISOString());
  }
  status(id: string, status: Run["status"]) {
    this.db
      .query("UPDATE runs SET status=? WHERE id=? AND status=?")
      .run(status, id, "running");
  }
  get(id: string): Run {
    const row = this.db
      .query<
        {
          id: string;
          config: string;
          status: string;
          fingerprint: string;
          created: string;
          owner: number;
        },
        [string]
      >("SELECT * FROM runs WHERE id=?")
      .get(id);
    if (!row) throw new Error("Review not found.");
    if (row.status === "running") {
      try {
        process.kill(row.owner, 0);
      } catch {
        this.status(id, "interrupted");
        row.status = "interrupted";
      }
    }
    return runSchema.parse({
      ...row,
      config: JSON.parse(row.config),
      messages: this.db
        .query(
          "SELECT id,speaker,round,text,time FROM messages WHERE run=? ORDER BY id",
        )
        .all(id),
    });
  }
  list() {
    return this.db
      .query<{ id: string }, []>(
        "SELECT id FROM runs ORDER BY created DESC LIMIT 30",
      )
      .all()
      .map((row) => this.get(row.id));
  }
  close() {
    this.db.close();
  }
}

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  defaults,
  settingsSchema,
  models,
  runSchema,
  messageSchema,
  participantSchema,
  type Settings,
  type Start,
  type Run,
  type Message,
} from "./schema";
export const dataDirectory = join(homedir(), ".local/share/review-room");
type CycleRow = {
  id: string;
  roomId: string;
  repo: string;
  label: string;
  prompt: string;
  status: string;
  created: string;
  turns: number;
  maxTurns: number;
  artifact: string | null;
  heartbeat: number;
  owner: string;
};
export class Store {
  private db: Database;
  constructor(path = join(dataDirectory, "agent-reviews.sqlite")) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cycles (id TEXT PRIMARY KEY,roomId TEXT NOT NULL,repo TEXT NOT NULL,label TEXT NOT NULL,prompt TEXT NOT NULL,status TEXT NOT NULL,created TEXT NOT NULL,turns INTEGER NOT NULL,maxTurns INTEGER NOT NULL,artifact TEXT,heartbeat INTEGER NOT NULL,owner TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS participants (run TEXT NOT NULL,name TEXT NOT NULL,harness TEXT NOT NULL,model TEXT NOT NULL,sessionId TEXT,state TEXT NOT NULL,PRIMARY KEY(run,name));
      CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT,run TEXT NOT NULL,sender TEXT NOT NULL,recipient TEXT NOT NULL,kind TEXT NOT NULL,text TEXT NOT NULL,time TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS queue (id INTEGER PRIMARY KEY AUTOINCREMENT,run TEXT NOT NULL,reviewer TEXT NOT NULL,text TEXT NOT NULL,replyTo TEXT);
      CREATE INDEX IF NOT EXISTS message_run ON messages(run,id);`);
  }
  settings(): Settings {
    const row = this.db
      .query<{ value: string }, []>("SELECT value FROM settings WHERE id=1")
      .get();
    return row ? settingsSchema.parse(JSON.parse(row.value)) : { ...defaults };
  }
  updateSettings(patch: Partial<Settings>) {
    return this.db.transaction(() => {
      const next = settingsSchema.parse({ ...this.settings(), ...patch });
      models(next.codexModels);
      models(next.claudeModels);
      this.db
        .query(
          "INSERT INTO settings VALUES (1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
        )
        .run(JSON.stringify(next));
      return next;
    })();
  }
  create(config: Start, owner: string) {
    return this.db.transaction(() => {
      const settings = this.settings();
      const roomId = config.roomId ?? crypto.randomUUID();
      const previous = this.db
        .query<
          { repo: string },
          [string]
        >("SELECT repo FROM cycles WHERE roomId=? LIMIT 1")
        .get(roomId);
      if (previous && previous.repo !== config.repo)
        throw new Error(
          "A review room belongs to one repository. Start a new room for another repository.",
        );
      if (
        this.db
          .query(
            "SELECT id FROM cycles WHERE roomId=? AND status IN ('running','ready','collecting')",
          )
          .get(roomId)
      )
        throw new Error(
          "Collect or stop the current cycle before starting another in this room.",
        );
      const id = crypto.randomUUID();
      this.db
        .query("INSERT INTO cycles VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(
          id,
          roomId,
          config.repo,
          config.label,
          config.prompt,
          "running",
          new Date().toISOString(),
          0,
          settings.maxTurns,
          null,
          Date.now(),
          owner,
        );
      for (const reviewer of config.reviewers) {
        const saved = settings.reuseSessions
          ? this.db
              .query<
                { sessionId: string | null },
                [string, string, string, string]
              >("SELECT p.sessionId FROM participants p JOIN cycles c ON c.id=p.run WHERE c.roomId=? AND c.status='completed' AND p.name=? AND p.harness=? AND p.model=? ORDER BY c.created DESC LIMIT 1")
              .get(roomId, reviewer.name, reviewer.harness, reviewer.model)
          : null;
        this.db
          .query("INSERT INTO participants VALUES (?,?,?,?,?,?)")
          .run(
            id,
            reviewer.name,
            reviewer.harness,
            reviewer.model,
            saved?.sessionId ?? null,
            "idle",
          );
        this.enqueue(id, reviewer.name, config.prompt);
      }
      this.message(id, "agent", "all", "message", config.prompt);
      return id;
    })();
  }
  message(
    run: string,
    sender: string,
    recipient: string,
    kind: Message["kind"],
    text: string,
  ) {
    this.db
      .query(
        "INSERT INTO messages (run,sender,recipient,kind,text,time) VALUES (?,?,?,?,?,?)",
      )
      .run(run, sender, recipient, kind, text, new Date().toISOString());
  }
  remaining(run: string) {
    return (
      this.db
        .query<
          { remaining: number },
          [string]
        >("SELECT maxTurns-turns-(SELECT count(*) FROM queue WHERE run=cycles.id) AS remaining FROM cycles WHERE id=?")
        .get(run)?.remaining ?? 0
    );
  }
  enqueue(
    run: string,
    reviewer: string,
    text: string,
    replyTo: string | null = null,
  ) {
    if (this.remaining(run) <= 0) {
      this.message(
        run,
        "Review Room",
        "agent",
        "status",
        `Turn limit reached; additional message to ${reviewer} was not queued.`,
      );
      return;
    }
    this.db
      .query("INSERT INTO queue (run,reviewer,text,replyTo) VALUES (?,?,?,?)")
      .run(run, reviewer, text, replyTo);
  }
  take(run: string, name: string) {
    return this.db.transaction(() => {
      const cycle = this.get(run, false);
      if (cycle.status !== "running") return;
      const row = this.db
        .query<
          { id: number; text: string; replyTo: string | null },
          [string, string]
        >("SELECT id,text,replyTo FROM queue WHERE run=? AND reviewer=? ORDER BY id LIMIT 1")
        .get(run, name);
      if (!row) return;
      if (cycle.turns >= cycle.maxTurns) {
        this.db.query("DELETE FROM queue WHERE run=?").run(run);
        this.message(
          run,
          "Review Room",
          "agent",
          "status",
          "Turn limit reached. Collect the findings and explicitly start another cycle if needed.",
        );
        return;
      }
      this.db.query("DELETE FROM queue WHERE id=?").run(row.id);
      this.db.query("UPDATE cycles SET turns=turns+1 WHERE id=?").run(run);
      this.db
        .query("UPDATE participants SET state='running' WHERE run=? AND name=?")
        .run(run, name);
      return { text: row.text, replyTo: row.replyTo };
    })();
  }
  finishTurn(run: string, name: string, sessionId: string | null) {
    this.db
      .query(
        "UPDATE participants SET state='idle',sessionId=? WHERE run=? AND name=?",
      )
      .run(sessionId, run, name);
  }
  settle(run: string) {
    this.db
      .query(
        `UPDATE cycles SET status='ready' WHERE id=? AND status='running' AND NOT EXISTS(SELECT 1 FROM queue WHERE run=?) AND NOT EXISTS(SELECT 1 FROM participants WHERE run=? AND state='running')`,
      )
      .run(run, run, run);
  }
  send(run: string, to: string, text: string) {
    return this.db.transaction(() => {
      const cycle = this.get(run, false);
      if (!["running", "ready"].includes(cycle.status))
        throw new Error("This cycle has ended; start a new review.");
      if (cycle.turns >= cycle.maxTurns)
        throw new Error("Turn limit reached. Collect and start another cycle.");
      const recipients =
        to === "all"
          ? cycle.reviewers
          : cycle.reviewers.filter((r) => r.name === to);
      if (!recipients.length) throw new Error("Unknown reviewer.");
      if (this.remaining(run) < recipients.length)
        throw new Error(
          "Not enough turns remain. Collect and start another cycle.",
        );
      this.db.query("UPDATE cycles SET status='running' WHERE id=?").run(run);
      this.message(run, "agent", to, "message", text);
      for (const r of recipients) this.enqueue(run, r.name, text);
    })();
  }
  status(run: string, status: Run["status"]) {
    this.db
      .query(
        `UPDATE cycles SET status=? WHERE id=? AND status IN ('running','ready','collecting')`,
      )
      .run(status, run);
    if (!["running", "ready", "collecting"].includes(status)) {
      this.db.query("DELETE FROM queue WHERE run=?").run(run);
      this.db
        .query(
          "UPDATE participants SET state=? WHERE run=? AND state='running'",
        )
        .run(status === "failed" ? "failed" : "idle", run);
    }
  }
  touch(owner: string) {
    this.db
      .query(
        "UPDATE cycles SET heartbeat=? WHERE owner=? AND status IN ('running','ready','collecting')",
      )
      .run(Date.now(), owner);
  }
  owned(owner: string) {
    return this.db
      .query<{ id: string }, [string]>(
        "SELECT id FROM cycles WHERE owner=? AND status IN ('running','ready')",
      )
      .all(owner)
      .map((row) => this.get(row.id, false));
  }
  get(id: string, withMessages = true): Run {
    const row = this.db
      .query<CycleRow, [string]>("SELECT * FROM cycles WHERE id=?")
      .get(id);
    if (!row) throw new Error("Review not found.");
    if (
      ["running", "ready", "collecting"].includes(row.status) &&
      Date.now() - row.heartbeat > 30000
    ) {
      this.status(id, "interrupted");
      row.status = "interrupted";
    }
    return runSchema.parse({
      ...row,
      reviewers: this.db
        .query(
          "SELECT name,harness,model,sessionId,state FROM participants WHERE run=? ORDER BY rowid",
        )
        .all(id)
        .map((r) => participantSchema.parse(r)),
      messages: withMessages ? this.messages(id, 0, 500) : [],
    });
  }
  messages(run: string, after: number, limit = 6, includeActivity = true) {
    return this.db
      .query(
        "SELECT id,sender,recipient,kind,text,time FROM messages WHERE run=? AND id>? AND (? OR kind<>'activity') ORDER BY id LIMIT ?",
      )
      .all(run, after, includeActivity ? 1 : 0, limit)
      .map((r) => messageSchema.parse(r));
  }
  list() {
    return this.db
      .query<{ id: string }, []>(
        "SELECT id FROM cycles ORDER BY created DESC LIMIT 30",
      )
      .all()
      .map((r) => this.get(r.id, false));
  }
  beginCollect(run: string) {
    const result = this.db
      .query(
        "UPDATE cycles SET status='collecting' WHERE id=? AND status='ready'",
      )
      .run(run);
    if (!result.changes)
      throw new Error("Wait until all reviewers are idle before collecting.");
  }
  collected(run: string, path: string) {
    this.db
      .query(
        "UPDATE cycles SET status='completed',artifact=? WHERE id=? AND status='collecting'",
      )
      .run(path, run);
  }
  close() {
    this.db.close();
  }
}

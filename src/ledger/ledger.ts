// The ledger (run-manager §2.4): ~/.factory/factory.db and ~/.factory/ledger/<runId>/
//   factory.db          table `events`: append-only, one row per event, written in a transaction
//   artifacts/<sha256>  content-addressed, durable writes
//   cards/<cardId>.md   human cards as shown
// A run folder outside a `ledger/` folder (an unpacked archive, a copy in a repo) has no database beside it: its
// events are read from, and written to, events.jsonl in the folder, one JSON event per line.
import {
  appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync,
  truncateSync, writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { LedgerEvent, type NewEvent } from "../contracts/index.js";
import { sha256, stableStringify } from "../util/hash.js";
import { fsyncDir, writeFileDurable } from "../util/fsx.js";
import { assertSupportedPath, paths } from "../util/paths.js";

type Db = import("node:sqlite").DatabaseSync;
let opened: { path: string; db: Db } | undefined;

/** The database beside a `ledger/` folder (one per factory home). One handle is kept open: the last home used. */
function dbAt(path: string): Db {
  if (opened?.path === path) return opened.db;
  opened?.db.close();
  // Node marks its SQLite as experimental and says so on every load; the factory's own output stays clean
  const warn = process.emitWarning;
  process.emitWarning = () => undefined;
  // readable by this user only, as the events file was (the write-ahead files take the same mode)
  if (!existsSync(path)) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "", { mode: 0o600 }); }
  let db: Db;
  try { db = new (createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite")).DatabaseSync(path); } finally { process.emitWarning = warn; }
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000; CREATE TABLE IF NOT EXISTS events (run_id TEXT NOT NULL, seq INTEGER NOT NULL, ts TEXT NOT NULL, type TEXT NOT NULL, epoch INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY (run_id, seq))");
  opened = { path, db };
  return db;
}

/** Where a run folder's database is: beside the `ledger/` folder that holds it. Any other folder has none. */
function dbPathFor(dir: string): string | undefined {
  return basename(dirname(dir)) === "ledger" ? join(dirname(dirname(dir)), "factory.db") : undefined;
}

export class LedgerCorruptError extends Error {}
export class FencedOutError extends Error {}

/** Who is writing. The executor passes its execution lock so stale executors are fenced out. */
export interface Writer {
  epoch(): number;
  /** Throws FencedOutError when this writer's epoch is no longer current. */
  assertCurrent?(): void;
}

export const HUMAN_WRITER: Writer = { epoch: () => 0 };

function tryParse(line: string): LedgerEvent | undefined {
  try {
    return LedgerEvent.parse(JSON.parse(line));
  } catch {
    return undefined;
  }
}

export class Ledger {
  readonly eventsPath: string;
  readonly artifactsDir: string;
  readonly cardsDir: string;
  private readonly dbPath: string | undefined;

  private constructor(readonly dir: string, readonly runId: string) {
    this.eventsPath = join(dir, "events.jsonl");
    this.artifactsDir = join(dir, "artifacts");
    this.cardsDir = join(dir, "cards");
    this.dbPath = dbPathFor(dir);
  }

  /** True when the folder is a run: its events are in the database beside it, or in its events.jsonl. */
  static isRun(dir: string): boolean {
    if (existsSync(join(dir, "events.jsonl"))) return true;
    const db = dbPathFor(dir);
    return !!db && existsSync(db) && !!dbAt(db).prepare("SELECT 1 FROM events WHERE run_id = ? LIMIT 1").get(basename(dir));
  }

  static exists(runId: string): boolean {
    return Ledger.isRun(paths.ledger(runId));
  }

  /** Create the folder for a new run. The caller appends run.created. */
  static create(runId: string, dir = paths.ledger(runId)): Ledger {
    assertSupportedPath(dir);
    if (Ledger.isRun(dir)) throw new Error(`Run ${runId} already exists`);
    mkdirSync(join(dir, "artifacts"), { recursive: true });
    mkdirSync(join(dir, "cards"), { recursive: true });
    // with a database the file stays empty: it marks the folder as a run (and is where `exportFile` writes)
    writeFileSync(join(dir, "events.jsonl"), "", { mode: 0o600 });
    fsyncDir(dir);
    return new Ledger(dir, runId);
  }

  static open(runId: string, dir = paths.ledger(runId)): Ledger {
    if (!Ledger.isRun(dir)) throw new Error(`No run ${runId}`);
    return new Ledger(dir, runId);
  }

  static listRuns(): string[] {
    const root = join(paths.ledger("x"), "..");
    const db = join(root, "..", "factory.db");
    const inDb = existsSync(db) ? (dbAt(db).prepare("SELECT DISTINCT run_id FROM events").all() as { run_id: string }[]).map((r) => r.run_id) : [];
    const inFiles = existsSync(root) ? readdirSync(root).filter((d) => existsSync(join(root, d, "events.jsonl"))) : [];
    return [...new Set([...inDb, ...inFiles])].sort();
  }

  // ---------- events ----------

  /** All events. Throws on corruption anywhere except a torn last line of an events file (repaired on append). */
  events(): LedgerEvent[] {
    if (!this.dbPath) return this.parse().events;
    const db = dbAt(this.dbPath);
    this.importFile(db);
    return this.rows(db);
  }

  private rows(db: Db): LedgerEvent[] {
    return (db.prepare("SELECT body FROM events WHERE run_id = ? ORDER BY seq").all(this.runId) as { body: string }[]).map((r, i) => {
      const ev = tryParse(r.body);
      if (!ev) throw new LedgerCorruptError(`Bad event ${i} of run ${this.runId} in ${this.dbPath}`);
      return ev;
    });
  }

  /**
   * A run from before the database (or one copied in from another machine): its events.jsonl is read into the database once,
   * in order. The file is left as it is and is not read again.
   */
  private importFile(db: Db): void {
    if (!existsSync(this.eventsPath) || db.prepare("SELECT 1 FROM events WHERE run_id = ? LIMIT 1").get(this.runId)) return;
    const { events } = this.parse();
    if (!events.length) return;
    db.exec("BEGIN IMMEDIATE");
    try {
      // another process may have imported it between the check and the lock
      if (!db.prepare("SELECT 1 FROM events WHERE run_id = ? LIMIT 1").get(this.runId)) for (const ev of events) this.insert(db, ev);
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
  }

  private insert(db: Db, ev: LedgerEvent): void {
    db.prepare("INSERT INTO events (run_id, seq, ts, type, epoch, body) VALUES (?, ?, ?, ?, ?, ?)").run(this.runId, ev.seq, ev.ts, ev.type, ev.epoch, JSON.stringify(ev));
  }

  /** Write the run's events to events.jsonl in its folder, so the folder can be copied, archived or read on another machine. */
  exportFile(): string {
    if (this.dbPath) writeFileDurable(this.eventsPath, this.events().map((e) => JSON.stringify(e) + "\n").join(""));
    return this.eventsPath;
  }

  private parse(): { events: LedgerEvent[]; tornAt?: number } {
    const raw = readFileSync(this.eventsPath, "utf8");
    if (raw === "") return { events: [] };
    const endsClean = raw.endsWith("\n");
    const lines = (endsClean ? raw.slice(0, -1) : raw).split("\n");
    const events: LedgerEvent[] = [];
    let offset = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const isLast = i === lines.length - 1;
      // a last line without its newline is a torn write, even if it happens to parse
      const ev = isLast && !endsClean ? undefined : tryParse(line);
      if (!ev) {
        if (isLast) return { events, tornAt: offset };
        throw new LedgerCorruptError(`Bad line ${i + 1} in ${this.eventsPath}`);
      }
      events.push(ev);
      offset += Buffer.byteLength(line) + 1;
    }
    return { events };
  }

  /** Append one event: in a transaction (database), or under the per-run lock and then fsync (events file). */
  async append(ev: NewEvent, writer: Writer): Promise<LedgerEvent> {
    const out = await this.appendIf(() => ev, writer);
    return out!;
  }

  /**
   * As one write nobody else can get between: read all events, let `decide` build the event (or return
   * undefined to write nothing), then append it. Used for hash checks.
   */
  async appendIf(decide: (events: LedgerEvent[]) => NewEvent | undefined, writer: Writer): Promise<LedgerEvent | undefined> {
    if (!this.dbPath) return this.appendIfFile(decide, writer);
    const db = dbAt(this.dbPath);
    this.importFile(db);
    let full: LedgerEvent | undefined;
    db.exec("BEGIN IMMEDIATE");
    try {
      writer.assertCurrent?.();
      const events = this.rows(db);
      const ev = decide(events);
      if (ev) this.insert(db, full = this.stamp(events, ev, writer));
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
    if (full) try { this.onAppend?.(full); } catch { /* observers never break the ledger */ }
    return full;
  }

  /** A torn last line is truncated and `ledger.repaired` is appended first. */
  private async appendIfFile(decide: (events: LedgerEvent[]) => NewEvent | undefined, writer: Writer): Promise<LedgerEvent | undefined> {
    const release = await lockfile.lock(this.eventsPath, {
      realpath: false, stale: 10_000, retries: { retries: 50, minTimeout: 20, maxTimeout: 200 },
    });
    try {
      writer.assertCurrent?.();
      let { events, tornAt } = this.parse();
      if (tornAt !== undefined) {
        truncateSync(this.eventsPath, tornAt);
        const repaired = this.write(events, { type: "ledger.repaired", data: { truncatedAt: tornAt } }, writer);
        events = [...events, repaired];
      }
      const ev = decide(events);
      return ev ? this.write(events, ev, writer) : undefined;
    } finally {
      await release();
    }
  }

  private stamp(existing: LedgerEvent[], ev: NewEvent, writer: Writer): LedgerEvent {
    const last = existing[existing.length - 1];
    return LedgerEvent.parse({
      ...ev,
      seq: last ? last.seq + 1 : 0,
      ts: new Date().toISOString(),
      runId: this.runId,
      epoch: writer.epoch(),
    });
  }

  private write(existing: LedgerEvent[], ev: NewEvent, writer: Writer): LedgerEvent {
    const full = this.stamp(existing, ev, writer);
    appendFileSync(this.eventsPath, JSON.stringify(full) + "\n");
    const fd = openSync(this.eventsPath, "r+");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    try { this.onAppend?.(full); } catch { /* observers never break the ledger */ }
    return full;
  }

  /** Observer for the run trace (after the event is durable). */
  onAppend?: (ev: LedgerEvent) => void;

  // ---------- artifacts ----------

  putArtifact(content: string | Uint8Array): string {
    const buf = typeof content === "string" ? Buffer.from(content) : content;
    const sha = sha256(buf);
    const p = join(this.artifactsDir, sha);
    if (!existsSync(p)) writeFileDurable(p, buf);
    return sha;
  }

  /** Stable JSON so the same value always gets the same sha. */
  putJson(value: unknown): string {
    return this.putArtifact(stableStringify(value));
  }

  hasArtifact(sha: string): boolean {
    return existsSync(join(this.artifactsDir, sha));
  }

  getArtifact(sha: string): Buffer {
    const buf = readFileSync(join(this.artifactsDir, sha));
    if (sha256(buf) !== sha) throw new LedgerCorruptError(`Artifact ${sha} does not match its hash`);
    return buf;
  }

  getJson<T = unknown>(sha: string): T {
    return JSON.parse(this.getArtifact(sha).toString("utf8")) as T;
  }

  // ---------- cards ----------

  writeCard(cardId: string, markdown: string): string {
    writeFileDurable(join(this.cardsDir, `${cardId}.md`), markdown);
    return this.putArtifact(markdown);
  }

  readCard(cardId: string): string {
    return readFileSync(join(this.cardsDir, `${cardId}.md`), "utf8");
  }
}

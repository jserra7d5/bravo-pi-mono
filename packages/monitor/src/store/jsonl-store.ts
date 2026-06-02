import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type {
  MonitorRecord,
  MonitorResult,
  MonitorEvent,
  MonitorListFilter,
  ResultQuery,
  EventFilter,
  LeaseSpec,
  PruneSummary,
} from "../schema/types.js";
import { NotFoundError, ConflictError } from "../errors.js";
import { generateMonitorId, generateResultId, generateEventId, generateLeaseId } from "../ids.js";
import { nowISO } from "../time.js";
import { resolveStateRoot } from "./state-path.js";
import { FileLock } from "./lock.js";

const SNAPSHOT_FILE = "monitors.snapshot.json";
const EVENTS_FILE = "monitors.events.jsonl";
const RESULTS_FILE = "monitors.results.jsonl";

const TERMINAL_STATES = new Set(["completed", "stopped", "canceled", "expired", "archived", "succeeded", "failed", "triggered"]);
const STATE_EVENT_TYPES = new Set(["started", "stopped", "triggered", "failed", "succeeded", "completed", "expired", "archived"]);

export class JsonlMonitorStore {
  private stateRoot: string;
  private monitors = new Map<string, MonitorRecord>();
  private results = new Map<string, MonitorResult[]>();
  private events: MonitorEvent[] = [];
  private initialized = false;

  constructor(stateRoot?: string) {
    this.stateRoot = stateRoot ?? resolveStateRoot();
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    mkdirSync(this.stateRoot, { recursive: true });
    this.loadSnapshot();
    this.loadEvents();
    this.loadResults();
    this.initialized = true;
  }

  private snapshotPath(): string {
    return join(this.stateRoot, SNAPSHOT_FILE);
  }

  private eventsPath(): string {
    return join(this.stateRoot, EVENTS_FILE);
  }

  private resultsPath(): string {
    return join(this.stateRoot, RESULTS_FILE);
  }

  private loadResults(): void {
    const path = this.resultsPath();
    if (!existsSync(path)) return;
    try {
      const text = readFileSync(path, "utf8");
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const result = JSON.parse(line) as MonitorResult;
          const arr = this.results.get(result.monitor_id) ?? [];
          arr.push(result);
          this.results.set(result.monitor_id, arr);
        } catch {
          // ignore bad line
        }
      }
    } catch {
      // ignore
    }
  }

  private saveResults(): void {
    const path = this.resultsPath();
    const tmp = path + ".tmp";
    const lines: string[] = [];
    for (const arr of this.results.values()) {
      for (const r of arr) {
        lines.push(JSON.stringify(r));
      }
    }
    writeFileSync(tmp, lines.join("\n") + (lines.length ? "\n" : ""), "utf8");
    renameSync(tmp, path);
  }

  private appendResultLine(result: MonitorResult): void {
    const path = this.resultsPath();
    const line = JSON.stringify(result) + "\n";
    appendFileSync(path, line, "utf8");
  }

  private loadSnapshot(): void {
    const path = this.snapshotPath();
    if (!existsSync(path)) return;
    try {
      const data = JSON.parse(readFileSync(path, "utf8")) as {
        monitors: MonitorRecord[];
      };
      for (const m of data.monitors ?? []) {
        this.monitors.set(m.monitor_id, m);
      }
    } catch {
      // ignore corrupt snapshot
    }
  }

  private saveSnapshot(): void {
    const path = this.snapshotPath();
    const tmp = path + ".tmp";
    const data = { updated_at: nowISO(), monitors: Array.from(this.monitors.values()) };
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
    renameSync(tmp, path);
  }

  private loadEvents(): void {
    const path = this.eventsPath();
    if (!existsSync(path)) return;
    try {
      const text = readFileSync(path, "utf8");
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as MonitorEvent;
          this.events.push(event);
          this.applyEvent(event);
        } catch {
          // ignore bad line
        }
      }
    } catch {
      // ignore
    }
  }

  private appendEventLine(event: MonitorEvent): void {
    const path = this.eventsPath();
    const line = JSON.stringify(event) + "\n";
    appendFileSync(path, line, "utf8");
  }

  private applyEvent(event: MonitorEvent): void {
    switch (event.type) {
      case "created":
      case "started":
      case "stopped":
      case "triggered":
      case "failed":
      case "succeeded":
      case "completed":
      case "expired":
      case "archived": {
        const m = this.monitors.get(event.monitor_id);
        if (!m) return;
        if (TERMINAL_STATES.has(m.state) && STATE_EVENT_TYPES.has(event.type) && event.type !== "archived" && event.type !== m.state) {
          return;
        }
        switch (event.type) {
          case "created":
            break;
          case "started":
            m.state = "running";
            break;
          case "stopped":
            m.state = "stopped";
            break;
          case "triggered":
            m.state = "triggered";
            m.last_triggered_at = nowISO();
            break;
          case "failed":
            m.state = "failed";
            break;
          case "succeeded":
            m.state = "succeeded";
            break;
          case "completed":
            m.state = "completed";
            break;
          case "expired":
            m.state = "expired";
            break;
          case "archived":
            m.state = "archived";
            break;
        }
        m.updated_at = event.created_at;
        break;
      }
    }
  }

  async create(record: MonitorRecord): Promise<MonitorRecord> {
    await this.init();
    this.monitors.set(record.monitor_id, record);
    this.saveSnapshot();
    const event: MonitorEvent = {
      event_id: generateEventId(),
      monitor_id: record.monitor_id,
      type: "created",
      created_at: nowISO(),
    };
    this.events.push(event);
    this.appendEventLine(event);
    return record;
  }

  async get(monitorId: string): Promise<MonitorRecord | undefined> {
    await this.init();
    return this.monitors.get(monitorId);
  }

  async list(filter: MonitorListFilter): Promise<MonitorRecord[]> {
    await this.init();
    let items = Array.from(this.monitors.values());
    if (filter.states?.length) {
      items = items.filter((m) => filter.states!.includes(m.state));
    }
    if (filter.scope) {
      items = items.filter((m) => m.scope === filter.scope);
    }
    if (filter.labels && Object.keys(filter.labels).length > 0) {
      items = items.filter((m) => {
        for (const [k, v] of Object.entries(filter.labels!)) {
          if (m.labels[k] !== v) return false;
        }
        return true;
      });
    }
    if (!filter.include_archived) {
      items = items.filter((m) => m.state !== "archived");
    }
    if (filter.limit && filter.limit > 0) {
      items = items.slice(0, filter.limit);
    }
    return items;
  }

  async update(
    monitorId: string,
    expectedVersion: number | undefined,
    patch: Partial<MonitorRecord>
  ): Promise<MonitorRecord> {
    await this.init();
    const m = this.monitors.get(monitorId);
    if (!m) throw new NotFoundError();
    if (expectedVersion !== undefined && m.version !== expectedVersion) {
      throw new ConflictError();
    }
    if (patch.state !== undefined && TERMINAL_STATES.has(m.state) && patch.state !== m.state && patch.state !== "archived") {
      throw new ConflictError();
    }
    const next = { ...m, ...patch, monitor_id: m.monitor_id, version: m.version + 1, updated_at: nowISO() };
    this.monitors.set(monitorId, next);
    this.saveSnapshot();
    return next;
  }

  async appendResult(result: MonitorResult): Promise<void> {
    await this.init();
    const arr = this.results.get(result.monitor_id) ?? [];
    arr.push(result);
    this.results.set(result.monitor_id, arr);
    this.appendResultLine(result);
    this.saveSnapshot();
  }

  async listResults(monitorId: string, options: ResultQuery): Promise<MonitorResult[]> {
    await this.init();
    let arr = this.results.get(monitorId) ?? [];
    if (options.after) {
      arr = arr.filter((r) => r.created_at > options.after!);
    }
    if (options.before) {
      arr = arr.filter((r) => r.created_at < options.before!);
    }
    arr = arr.sort((a, b) => b.created_at.localeCompare(a.created_at));
    if (options.limit && options.limit > 0) {
      arr = arr.slice(0, options.limit);
    }
    return arr;
  }

  async updateResult(monitorId: string, resultId: string, patch: Partial<MonitorResult>): Promise<MonitorResult | undefined> {
    await this.init();
    const arr = this.results.get(monitorId) ?? [];
    const idx = arr.findIndex((r) => r.result_id === resultId);
    if (idx < 0) return undefined;
    const updated = { ...arr[idx]!, ...patch };
    arr[idx] = updated;
    this.results.set(monitorId, arr);
    this.saveResults();
    return updated;
  }

  async appendEvent(event: MonitorEvent): Promise<void> {
    await this.init();
    this.events.push(event);
    this.applyEvent(event);
    this.appendEventLine(event);
    this.saveSnapshot();
  }

  async listEvents(filter: EventFilter): Promise<MonitorEvent[]> {
    await this.init();
    let arr = this.events;
    if (filter.monitor_id) {
      arr = arr.filter((e) => e.monitor_id === filter.monitor_id);
    }
    if (filter.types?.length) {
      arr = arr.filter((e) => filter.types!.includes(e.type));
    }
    arr = arr.sort((a, b) => b.created_at.localeCompare(a.created_at));
    if (filter.limit && filter.limit > 0) {
      arr = arr.slice(0, filter.limit);
    }
    return arr;
  }

  async claimDue(now: Date, _lease: LeaseSpec, filter?: (monitor: MonitorRecord) => boolean): Promise<MonitorRecord[]> {
    await this.init();
    const due: MonitorRecord[] = [];
    for (const m of this.monitors.values()) {
      if (m.state !== "running") continue;
      if (filter && !filter(m)) continue;
      if (m.next_run_at && Date.parse(m.next_run_at) <= now.getTime()) {
        if (m.lease_expires_at && Date.parse(m.lease_expires_at) > now.getTime()) continue;
        due.push(m);
      }
    }
    // claim leases
    const claimed: MonitorRecord[] = [];
    for (const m of due) {
      const leaseId = generateLeaseId();
      const expires = new Date(now.getTime() + _lease.ttl_ms).toISOString();
      const next = { ...m, lease_id: leaseId, lease_expires_at: expires, version: m.version + 1, updated_at: nowISO() };
      this.monitors.set(m.monitor_id, next);
      claimed.push(next);
    }
    if (claimed.length) this.saveSnapshot();
    return claimed;
  }

  async releaseLease(monitorId: string, leaseId: string, nextRunAt?: string): Promise<void> {
    await this.init();
    const m = this.monitors.get(monitorId);
    if (!m || m.lease_id !== leaseId) return;
    const next: MonitorRecord = {
      ...m,
      lease_id: undefined,
      lease_expires_at: undefined,
      next_run_at: nextRunAt,
      version: m.version + 1,
      updated_at: nowISO(),
    };
    this.monitors.set(monitorId, next);
    this.saveSnapshot();
  }


  async prune(_now: Date): Promise<PruneSummary> {
    await this.init();
    const summary: PruneSummary = { results_removed: 0, events_removed: 0, monitors_archived: 0 };
    // Prune old results
    for (const [mid, arr] of this.results) {
      const m = this.monitors.get(mid);
      const maxResults = m?.retention?.max_results ?? 100;
      if (arr.length > maxResults) {
        const keep = arr.slice(-maxResults);
        summary.results_removed += arr.length - keep.length;
        this.results.set(mid, keep);
      }
    }
    if (summary.results_removed > 0) {
      this.saveResults();
    }
    // Prune old events
    const maxEvents = 5000;
    if (this.events.length > maxEvents) {
      const removed = this.events.length - maxEvents;
      this.events = this.events.slice(-maxEvents);
      summary.events_removed = removed;
      // Rewrite events file
      const path = this.eventsPath();
      writeFileSync(path, this.events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    }
    // Archive very old terminal monitors (older than 30 days)
    const archiveThreshold = 30 * 24 * 60 * 60 * 1000;
    for (const m of this.monitors.values()) {
      const terminal = new Set(["completed", "stopped", "canceled", "expired", "succeeded"]);
      if (terminal.has(m.state) && Date.parse(m.updated_at) < _now.getTime() - archiveThreshold) {
        m.state = "archived";
        m.updated_at = nowISO();
        summary.monitors_archived++;
      }
    }
    if (summary.monitors_archived) this.saveSnapshot();
    return summary;
  }

  // For testing only
  _reset(stateRoot?: string): void {
    this.monitors.clear();
    this.results.clear();
    this.events = [];
    this.initialized = false;
    if (stateRoot !== undefined) this.stateRoot = stateRoot;
  }
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import type { ProtoChangeReport, ProtoSnapshotsStore } from "../types.js";

const STATE_DIR = resolve(import.meta.dirname, "../../state");
const SNAPSHOTS_PATH = resolve(STATE_DIR, "proto-snapshots.json");
const REPORT_PATH = resolve(STATE_DIR, "proto-change-report.json");

export function loadProtoSnapshots(): ProtoSnapshotsStore {
  if (!existsSync(SNAPSHOTS_PATH)) {
    return { services: {}, lastUpdated: new Date(0).toISOString() };
  }

  return JSON.parse(readFileSync(SNAPSHOTS_PATH, "utf-8"));
}

export function saveProtoSnapshots(store: ProtoSnapshotsStore): void {
  mkdirSync(dirname(SNAPSHOTS_PATH), { recursive: true });
  store.lastUpdated = new Date().toISOString();
  writeFileSync(SNAPSHOTS_PATH, JSON.stringify(store, null, 2));
}

export function loadProtoChangeReport(): ProtoChangeReport | null {
  if (!existsSync(REPORT_PATH)) return null;
  return JSON.parse(readFileSync(REPORT_PATH, "utf-8"));
}

export function saveProtoChangeReport(report: ProtoChangeReport): void {
  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
}

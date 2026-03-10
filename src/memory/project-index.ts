import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import type { ProjectIndex, ServiceIndex } from "../types.js";

const STATE_DIR = resolve(import.meta.dirname, "../../state");
const INDEX_PATH = resolve(STATE_DIR, "project-index.json");

export function loadProjectIndex(): ProjectIndex {
  if (!existsSync(INDEX_PATH)) {
    return { services: {}, lastUpdated: new Date().toISOString() };
  }
  return JSON.parse(readFileSync(INDEX_PATH, "utf-8"));
}

export function saveProjectIndex(index: ProjectIndex): void {
  mkdirSync(dirname(INDEX_PATH), { recursive: true });
  index.lastUpdated = new Date().toISOString();
  writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2));
}

export function updateServiceIndex(
  serviceName: string,
  data: Partial<ServiceIndex>,
): void {
  const index = loadProjectIndex();
  const existing = index.services[serviceName] ?? {
    protoFile: "",
    methods: [],
    wrapperExists: false,
    typesExist: false,
    testFiles: [],
    coveragePercent: 0,
  };

  index.services[serviceName] = { ...existing, ...data };
  saveProjectIndex(index);
}

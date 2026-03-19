// ============================================================
// Testomatio REST API client
// ============================================================

const BASE_URL_V1 = "https://app.testomat.io/api/v1";  // api_key auth
const BASE_URL     = "https://app.testomat.io/api";     // JWT auth (tests endpoints)

function getApiKey(): string {
  const key = process.env.TESTOMATIO_API_KEY;
  if (!key) throw new Error("TESTOMATIO_API_KEY is not set in .env");
  return key;
}

function getProject(): string {
  return process.env.TESTOMATIO_PROJECT ?? "skill-trade";
}

// ─── Auth: api_key (for suites listing) ──────────────────────

async function requestV1<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const allParams = new URLSearchParams({ ...params, api_key: getApiKey() });
  const url = `${BASE_URL_V1}/projects/${getProject()}${path}?${allParams}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Testomatio API error: ${res.status} ${res.statusText} — ${url}`);
  return res.json() as Promise<T>;
}

// ─── Auth: JWT Bearer (for tests listing and details) ────────

let _jwt: string | null = null;

async function getJwt(): Promise<string | null> {
  if (_jwt) return _jwt;
  const key = process.env.TESTOMATIO_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(`${BASE_URL}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `api_token=${encodeURIComponent(key)}`,
    });
    if (!res.ok) return null;
    const data = await res.json() as { jwt?: string };
    _jwt = data.jwt ?? null;
    return _jwt;
  } catch {
    return null;
  }
}

async function requestJwt<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const jwt = await getJwt();
  const query = Object.keys(params).length ? `?${new URLSearchParams(params)}` : "";
  const url = `${BASE_URL}/${getProject()}${path}${query}`;
  const headers: Record<string, string> = jwt ? { Authorization: `Bearer ${jwt}` } : {};
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Testomatio API error: ${res.status} ${res.statusText} — ${url}`);
  return res.json() as Promise<T>;
}

// ─── Types ───────────────────────────────────────────────────

export interface TestomatioSuite {
  id: string;
  title: string;
  tests_count: number;
}

export interface TestomatioTest {
  id: string;
  title: string;
  suite_id: string;
  automated: boolean;
  tags?: string[];
}

export interface TestomatioTestDetail {
  id: string;
  title: string;
  description: string | null;
  tags: string[];
  suite_id: string;
  automated: boolean;
}

export interface ServiceCoverage {
  suiteTitle: string | null;
  totalTests: number;
  manualTests: number;
  automatedTests: number;
}

// ─── Suites (api_key) ────────────────────────────────────────

export async function getSuites(): Promise<TestomatioSuite[]> {
  const data = await requestV1<{ suites: TestomatioSuite[] }>("/suites");
  return data.suites ?? [];
}

// ─── Tests listing by suite (JWT) ────────────────────────────

/**
 * Fetch all tests for a suite. Uses JWT-authenticated endpoint.
 * Handles both simple { tests: [...] } and JSON:API { data: [...] } formats.
 */
export async function getTestsBySuiteId(suiteId: string): Promise<TestomatioTest[]> {
  if (!process.env.TESTOMATIO_API_KEY) return [];
  try {
    const raw = await requestJwt<Record<string, unknown>>("/tests", { suite_id: suiteId });

    // Simple format: { tests: [...] }
    if (Array.isArray(raw["tests"])) {
      return raw["tests"] as TestomatioTest[];
    }

    // JSON:API format: { data: [{ id, type, attributes }] }
    if (Array.isArray(raw["data"])) {
      type JItem = { id: string; attributes: Record<string, unknown> };
      return (raw["data"] as JItem[]).map((item) => ({
        id: item.id,
        title: (item.attributes["public-title"] ?? item.attributes["title"] ?? "") as string,
        suite_id: (item.attributes["suite-id"] ?? suiteId) as string,
        automated: item.attributes["state"] === "automated",
        tags: (item.attributes["tags"] ?? []) as string[],
      }));
    }

    return [];
  } catch {
    return [];
  }
}

// ─── Single test detail (JWT) ────────────────────────────────

/**
 * Fetch full test details including description (Preconditions + Steps + Expected).
 * API returns JSON:API format: { data: { attributes: { description, ... } } }
 */
export async function getTestDetail(testId: string): Promise<TestomatioTestDetail | null> {
  if (!process.env.TESTOMATIO_API_KEY) return null;
  try {
    const raw = await requestJwt<Record<string, unknown>>(`/tests/${testId}`);

    // JSON:API single resource: { data: { id, attributes } }
    const data = raw["data"] as { id: string; attributes: Record<string, unknown> } | undefined;
    if (!data) return null;

    const attrs = data.attributes;
    return {
      id: data.id,
      title: (attrs["public-title"] ?? attrs["title"] ?? "") as string,
      description: (attrs["description"] ?? null) as string | null,
      tags: (attrs["tags"] ?? []) as string[],
      suite_id: (attrs["suite-id"] ?? "") as string,
      automated: attrs["state"] === "automated",
    };
  } catch {
    return null;
  }
}

// ─── Fetch suite + enrich with descriptions (JWT) ────────────

/**
 * Fetch all tests for a suite and enrich each with full description.
 * Runs detail fetches in parallel batches of 5.
 */
export async function getTestsWithDetails(suiteId: string): Promise<TestomatioTestDetail[]> {
  const tests = await getTestsBySuiteId(suiteId);
  if (tests.length === 0) return [];

  const BATCH = 5;
  const results: TestomatioTestDetail[] = [];

  for (let i = 0; i < tests.length; i += BATCH) {
    const batch = tests.slice(i, i + BATCH);
    const details = await Promise.all(batch.map((t) => getTestDetail(t.id)));
    for (let j = 0; j < batch.length; j++) {
      const detail = details[j];
      if (detail) {
        results.push(detail);
      } else {
        results.push({
          id: batch[j].id,
          title: batch[j].title,
          description: null,
          tags: batch[j].tags ?? [],
          suite_id: batch[j].suite_id,
          automated: batch[j].automated,
        });
      }
    }
  }

  return results;
}

// ─── Service coverage (api_key) ──────────────────────────────

export async function getServiceCoverage(
  testomatioKey: string | null
): Promise<ServiceCoverage | null> {
  if (!testomatioKey) return null;

  const suites = await getSuites();
  const suite = suites.find((s) =>
    s.title.toLowerCase() === testomatioKey.toLowerCase()
  );
  if (!suite) return null;

  const tests = await getTestsBySuiteId(suite.id);
  const automated = tests.filter((t) => t.automated).length;
  const manual = tests.length - automated;

  return {
    suiteTitle: suite.title,
    totalTests: tests.length,
    manualTests: manual,
    automatedTests: automated,
  };
}

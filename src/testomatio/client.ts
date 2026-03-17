// ============================================================
// Testomatio REST API client
// Docs: https://docs.testomat.io/api/
// ============================================================

const BASE_URL = "https://app.testomat.io/api/v1";

function getApiKey(): string {
  const key = process.env.TESTOMATIO_API_KEY;
  if (!key) throw new Error("TESTOMATIO_API_KEY is not set in .env");
  return key;
}

function getProject(): string {
  return process.env.TESTOMATIO_PROJECT ?? "skill-trade";
}

async function request<T>(path: string): Promise<T> {
  const url = `${BASE_URL}/projects/${getProject()}${path}?api_key=${getApiKey()}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Testomatio API error: ${res.status} ${res.statusText} — ${url}`);
  }
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
}

export interface ServiceCoverage {
  suiteTitle: string | null;
  totalTests: number;
  manualTests: number;
  automatedTests: number;
}

// ─── API methods ─────────────────────────────────────────────

export async function getSuites(): Promise<TestomatioSuite[]> {
  const data = await request<{ suites: TestomatioSuite[] }>("/suites");
  return data.suites ?? [];
}

export async function getTestsForSuite(suiteId: string): Promise<TestomatioTest[]> {
  const data = await request<{ tests: TestomatioTest[] }>(`/suites/${suiteId}/tests`);
  return data.tests ?? [];
}

/**
 * Find coverage for a service by its testomatio suite key (e.g. "partners").
 * Returns null if the service has no suite in Testomatio yet.
 */
export async function getServiceCoverage(
  testomatioKey: string | null
): Promise<ServiceCoverage | null> {
  if (!testomatioKey) return null;

  const suites = await getSuites();
  const suite = suites.find((s) =>
    s.title.toLowerCase() === testomatioKey.toLowerCase()
  );
  if (!suite) return null;

  const tests = await getTestsForSuite(suite.id);
  const automated = tests.filter((t) => t.automated).length;
  const manual = tests.length - automated;

  return {
    suiteTitle: suite.title,
    totalTests: tests.length,
    manualTests: manual,
    automatedTests: automated,
  };
}

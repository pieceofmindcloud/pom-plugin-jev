import { getPluginApi } from "./host/runtime";

declare const __POM_PLUGIN_CODE__: string;

export type QuestionType = "noul" | "choice" | "score";

export type Question = {
  type: QuestionType;
  instructions: string;
  criteria?: Record<string, string | null> | string[] | { true?: string; false?: string };
};

export type NoulAnswer = { type: "noul"; noul: number };
export type ChoiceAnswer = {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};
export type ScoreAnswer = {
  type: "score";
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
};
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export type QuestionTrace = {
  label_mass?: number;
  input_tokens?: number;
  cached_tokens?: number;
  duration_ms?: number;
};

export type DecisionResponse = {
  model: string;
  answers: Record<string, Answer>;
  usage?: { input_tokens: number; output_tokens: number };
  x_pom?: { questions?: Record<string, QuestionTrace>; duration_ms?: number };
};

export type DecisionRequest = {
  model?: string;
  state: unknown;
  questions: Record<string, Question>;
};

const PROXY = `/api/ui/plugins/${encodeURIComponent(__POM_PLUGIN_CODE__)}/proxy`;

/** The POM gateway path the plugin backend calls, for the copied curl. */
export const ENDPOINT = "/v1/systemone";

export class DecisionError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function errorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const error = (body as { error?: unknown }).error;
    if (typeof error === "string") return error;
    if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
      return (error as { message: string }).message;
    }
  }
  return fallback;
}

/** Asks the POM through this plugin's backend, which adds the gateway key. */
export async function decide(request: DecisionRequest, signal?: AbortSignal): Promise<DecisionResponse> {
  const response = await fetch(`${PROXY}/decide`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    credentials: "same-origin",
    cache: "no-store",
    signal,
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) throw new DecisionError(errorMessage(body, `HTTP ${response.status}`), response.status);
  return body as DecisionResponse;
}

export async function listModels(): Promise<string[]> {
  const body = await getPluginApi<{ data?: { id?: unknown }[] }>("models");
  return (body.data ?? []).map((model) => model.id).filter((id): id is string => typeof id === "string");
}

export function curlFor(request: DecisionRequest): string {
  const origin = typeof location === "undefined" ? "http://<pom>:8080" : location.origin;
  return [
    `curl ${origin}${ENDPOINT} \\`,
    `  -H "Authorization: Bearer $POM_API_KEY" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '${JSON.stringify(request, null, 2).replaceAll("'", "'\\''")}'`,
  ].join("\n");
}

/** Probabilities sorted from the most likely, for bars and the demo log. */
export function ranked(probabilities: Record<string, number>): [string, number][] {
  return Object.entries(probabilities).sort((a, b) => b[1] - a[1]);
}

export const percent = (value: number) => `${Math.round(value * 1000) / 10}%`;

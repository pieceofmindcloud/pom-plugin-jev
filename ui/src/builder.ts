/** The playground's editable model of a request, and its JSON round trip. */
import type { Question, QuestionType } from "./jev";

export type OptionRow = { key: string; name: string; detail: string };

export type DraftQuestion = {
  key: string;
  id: string;
  type: QuestionType;
  instructions: string;
  yes: string;
  no: string;
  options: OptionRow[];
  levels: OptionRow[];
};

export const LIMITS = { questions: 64, choice: [2, 26], score: [2, 10] } as const;
const ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

let counter = 0;
export const newKey = () => `k${Date.now().toString(36)}${(counter++).toString(36)}`;
const row = (name = "", detail = ""): OptionRow => ({ key: newKey(), name, detail });

export function blankQuestion(type: QuestionType, taken: string[]): DraftQuestion {
  let index = taken.length + 1;
  while (taken.includes(`question_${index}`)) index++;
  return {
    key: newKey(),
    id: `question_${index}`,
    type,
    instructions: "",
    yes: "",
    no: "",
    options: [row("option_a"), row("option_b")],
    levels: [row("Low"), row("Medium"), row("High")],
  };
}

export function fromApi(questions: Record<string, Question>): DraftQuestion[] {
  return Object.entries(questions).map(([id, question]) => {
    const draft = blankQuestion(question.type, []);
    draft.id = id;
    draft.instructions = question.instructions ?? "";
    const criteria = question.criteria;
    if (question.type === "noul" && criteria && !Array.isArray(criteria)) {
      const map = criteria as { true?: string; false?: string };
      draft.yes = map.true ?? "";
      draft.no = map.false ?? "";
    }
    if (question.type === "choice" && criteria && !Array.isArray(criteria)) {
      draft.options = Object.entries(criteria as Record<string, string | null>).map(([name, detail]) =>
        row(name, typeof detail === "string" ? detail : ""),
      );
    }
    if (question.type === "score" && Array.isArray(criteria)) {
      draft.levels = criteria.map((level) => row(String(level)));
    }
    return draft;
  });
}

export function toApi(drafts: DraftQuestion[]): Record<string, Question> {
  const out: Record<string, Question> = {};
  for (const draft of drafts) {
    const question: Question = { type: draft.type, instructions: draft.instructions };
    if (draft.type === "noul" && (draft.yes.trim() || draft.no.trim())) {
      question.criteria = {
        ...(draft.yes.trim() ? { true: draft.yes.trim() } : {}),
        ...(draft.no.trim() ? { false: draft.no.trim() } : {}),
      };
    }
    if (draft.type === "choice") {
      question.criteria = Object.fromEntries(
        draft.options.map((option) => [option.name.trim(), option.detail.trim() || null]),
      );
    }
    if (draft.type === "score") question.criteria = draft.levels.map((level) => level.name.trim());
    out[draft.id.trim()] = question;
  }
  return out;
}

export type Issue = { key: string | null; field: string; message: string };

/** Problems that would make the POM refuse the request, per question. */
export function validate(drafts: DraftQuestion[]): Issue[] {
  const issues: Issue[] = [];
  if (drafts.length === 0) issues.push({ key: null, field: "questions", message: "noQuestions" });
  if (drafts.length > LIMITS.questions) issues.push({ key: null, field: "questions", message: "tooManyQuestions" });
  const seen = new Set<string>();
  for (const draft of drafts) {
    const id = draft.id.trim();
    if (!ID_PATTERN.test(id)) issues.push({ key: draft.key, field: "id", message: "badId" });
    else if (seen.has(id)) issues.push({ key: draft.key, field: "id", message: "duplicateId" });
    seen.add(id);
    if (!draft.instructions.trim()) issues.push({ key: draft.key, field: "instructions", message: "noInstructions" });
    if (draft.type === "choice") {
      const names = draft.options.map((option) => option.name.trim());
      const [min, max] = LIMITS.choice;
      if (names.length < min || names.length > max) issues.push({ key: draft.key, field: "options", message: "choiceCount" });
      if (names.some((name) => !name)) issues.push({ key: draft.key, field: "options", message: "emptyOption" });
      if (new Set(names).size !== names.length) issues.push({ key: draft.key, field: "options", message: "duplicateOption" });
    }
    if (draft.type === "score") {
      const [min, max] = LIMITS.score;
      if (draft.levels.length < min || draft.levels.length > max) issues.push({ key: draft.key, field: "levels", message: "scoreCount" });
      if (draft.levels.some((level) => !level.name.trim())) issues.push({ key: draft.key, field: "levels", message: "emptyLevel" });
    }
  }
  return issues;
}

/** The state as sent: JSON when it parses as an object or array, text otherwise. */
export function parseState(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return text;
    }
  }
  return text;
}

export const stateIsJson = (text: string) => typeof parseState(text) !== "string";

export function move<T>(items: T[], index: number, delta: number): T[] {
  const target = index + delta;
  if (target < 0 || target >= items.length) return items;
  const next = items.slice();
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { usePluginI18n } from "../host/runtime";
import { EXAMPLES } from "../examples";
import {
  curlFor,
  decide,
  listModels,
  percent,
  ranked,
  type Answer,
  type DecisionRequest,
  type DecisionResponse,
  type Question,
  type QuestionTrace,
} from "../jev";

type Parsed = { request: DecisionRequest | null; error: string | null };

function parse(state: string, questions: string, model: string): Parsed {
  let parsedQuestions: unknown;
  try {
    parsedQuestions = JSON.parse(questions);
  } catch (error) {
    return { request: null, error: (error as Error).message };
  }
  if (!parsedQuestions || typeof parsedQuestions !== "object" || Array.isArray(parsedQuestions)) {
    return { request: null, error: "questions" };
  }
  let parsedState: unknown = state;
  const trimmed = state.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      parsedState = JSON.parse(trimmed);
    } catch {
      parsedState = state;
    }
  }
  return {
    request: {
      ...(model ? { model } : {}),
      state: parsedState,
      questions: parsedQuestions as Record<string, Question>,
    },
    error: null,
  };
}

function Bars({ entries, winner }: { entries: [string, number][]; winner?: string }) {
  return (
    <ul className="pb-bars">
      {entries.map(([label, value]) => (
        <li key={label} className={label === winner ? "pb-bar pb-bar-win" : "pb-bar"}>
          <span className="pb-bar-label">{label}</span>
          <span className="pb-bar-track" aria-hidden="true">
            <span className="pb-bar-fill" style={{ width: `${Math.max(value * 100, 0.5)}%` }} />
          </span>
          <span className="pb-bar-value">{percent(value)}</span>
        </li>
      ))}
    </ul>
  );
}

function Meter({ label, value }: { label: string; value: number }) {
  return (
    <div className="pb-meter">
      <span className="pb-meter-label">{label}</span>
      <span className="pb-meter-track" aria-hidden="true">
        <span className="pb-meter-fill" style={{ width: `${Math.min(Math.max(value, 0), 1) * 100}%` }} />
      </span>
      <span className="pb-meter-value">{percent(value)}</span>
    </div>
  );
}

function AnswerCard({ id, answer, trace }: { id: string; answer: Answer; trace?: QuestionTrace }) {
  const { t } = usePluginI18n();
  return (
    <article className="pb-card pb-answer">
      <header className="pb-answer-head">
        <code className="pb-answer-id">{id}</code>
        <span className={`pb-type pb-type-${answer.type}`}>{answer.type}</span>
      </header>
      {answer.type === "noul" && (
        <>
          <p className="pb-answer-value">
            {answer.noul >= 0.5 ? t("answer.yes") : t("answer.no")}
            <small>noul {answer.noul.toFixed(3)}</small>
          </p>
          <Bars entries={[["true", answer.noul], ["false", 1 - answer.noul]]} winner={answer.noul >= 0.5 ? "true" : "false"} />
        </>
      )}
      {answer.type === "choice" && (
        <>
          <p className="pb-answer-value">{answer.choice}</p>
          <Bars entries={ranked(answer.probabilities)} winner={answer.choice} />
          <Meter label={t("answer.confidence")} value={answer.confidence} />
        </>
      )}
      {answer.type === "score" && (
        <>
          <p className="pb-answer-value">
            {answer.score.toFixed(2)}
            <small>{answer.legend[String(Math.round(answer.score))] ?? ""}</small>
          </p>
          <Bars
            entries={Object.entries(answer.probabilities).map(([level, value]) => [
              `${level} · ${answer.legend[level] ?? ""}`,
              value,
            ])}
            winner={`${Math.round(answer.score)} · ${answer.legend[String(Math.round(answer.score))] ?? ""}`}
          />
          <Meter label={t("answer.confidence")} value={answer.confidence} />
        </>
      )}
      {trace && (
        <footer className="pb-answer-trace">
          {trace.duration_ms !== undefined && <span>{trace.duration_ms} ms</span>}
          {trace.input_tokens !== undefined && <span>{t("trace.tokens", { count: trace.input_tokens })}</span>}
          {trace.cached_tokens !== undefined && <span>{t("trace.cached", { count: trace.cached_tokens })}</span>}
          {trace.label_mass !== undefined && (
            <span title={t("trace.massHint")}>{t("trace.mass", { value: percent(trace.label_mass) })}</span>
          )}
        </footer>
      )}
    </article>
  );
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function Playground() {
  const { t } = usePluginI18n();
  const [state, setState] = useState(EXAMPLES[0].state);
  const [questions, setQuestions] = useState(JSON.stringify(EXAMPLES[0].questions, null, 2));
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<DecisionResponse | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    listModels()
      .then((ids) => {
        if (!active) return;
        setModels(ids);
        setModel((current) => current || ids[0] || "");
      })
      .catch(() => {
        if (active) setModels([]);
      });
    return () => {
      active = false;
    };
  }, []);

  const parsed = useMemo(() => parse(state, questions, model), [state, questions, model]);

  const run = useCallback(async () => {
    if (!parsed.request || running) return;
    setRunning(true);
    setFailure(null);
    try {
      setResult(await decide(parsed.request));
    } catch (error) {
      setResult(null);
      setFailure((error as Error).message);
    } finally {
      setRunning(false);
    }
  }, [parsed.request, running]);

  const onKey = (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      void run();
    }
  };

  const flash = async (key: string, text: string) => {
    if (await copy(text)) {
      setCopied(key);
      window.setTimeout(() => setCopied(null), 1400);
    }
  };

  const loadExample = (id: string) => {
    const example = EXAMPLES.find((item) => item.id === id);
    if (!example) return;
    setState(example.state);
    setQuestions(JSON.stringify(example.questions, null, 2));
    setResult(null);
    setFailure(null);
  };

  return (
    <main className="pb-page">
      <header className="pb-head">
        <div>
          <p className="pb-eyebrow"><span className="pb-tick" aria-hidden="true" />{t("playground.eyebrow")}</p>
          <h1 className="pb-title">{t("playground.title")}</h1>
          <p className="pb-lede">{t("playground.body")}</p>
        </div>
        <div className="pb-toolbar">
          <label className="pb-field">
            <span>{t("playground.example")}</span>
            <select defaultValue="" onChange={(event) => loadExample(event.target.value)}>
              <option value="" disabled>{t("playground.examplePick")}</option>
              {EXAMPLES.map((example) => (
                <option key={example.id} value={example.id}>{t(`example.${example.id}`)}</option>
              ))}
            </select>
          </label>
          <label className="pb-field">
            <span>{t("playground.model")}</span>
            <select value={model} onChange={(event) => setModel(event.target.value)}>
              {models.length === 0 && <option value="">{t("playground.modelActive")}</option>}
              {models.map((id) => (
                <option key={id} value={id}>{id}</option>
              ))}
            </select>
          </label>
          <button type="button" className="pb-btn pb-btn-accent" disabled={!parsed.request || running} onClick={() => void run()}>
            {running ? t("playground.running") : t("playground.run")}
            <kbd>Ctrl ↵</kbd>
          </button>
        </div>
      </header>

      <div className="pb-split" onKeyDown={onKey}>
        <section className="pb-editors">
          <label className="pb-editor">
            <span className="pb-editor-label">{t("playground.state")}</span>
            <textarea spellCheck={false} value={state} onChange={(event) => setState(event.target.value)} rows={7} />
            <span className="pb-hint">{t("playground.stateHint")}</span>
          </label>
          <label className="pb-editor">
            <span className="pb-editor-label">{t("playground.questions")}</span>
            <textarea
              spellCheck={false}
              value={questions}
              onChange={(event) => setQuestions(event.target.value)}
              rows={18}
              aria-invalid={parsed.error !== null}
            />
            {parsed.error ? (
              <span className="pb-hint pb-hint-error">{t("playground.invalid", { error: parsed.error })}</span>
            ) : (
              <span className="pb-hint">{t("playground.questionsHint")}</span>
            )}
          </label>
          <div className="pb-btn-row">
            <button
              type="button"
              className="pb-btn pb-btn-outline pb-btn-small"
              disabled={!parsed.request}
              onClick={() => parsed.request && void flash("curl", curlFor(parsed.request))}
            >
              {copied === "curl" ? t("copy.done") : t("copy.curl")}
            </button>
          </div>
        </section>

        <section className="pb-results" aria-live="polite">
          <div className="pb-results-head">
            <span className="pb-editor-label">{t("playground.response")}</span>
            {result && (
              <span className="pb-results-meta">
                <code>{result.model}</code>
                {result.x_pom?.duration_ms !== undefined && <span>{result.x_pom.duration_ms} ms</span>}
                <button
                  type="button"
                  className="pb-btn pb-btn-outline pb-btn-small"
                  onClick={() => void flash("json", JSON.stringify(result, null, 2))}
                >
                  {copied === "json" ? t("copy.done") : t("copy.json")}
                </button>
              </span>
            )}
          </div>
          {running && !result && <p className="pb-card pb-state pb-pulse">{t("playground.running")}</p>}
          {failure && <p className="pb-card pb-state pb-error" role="alert">{failure}</p>}
          {!running && !result && !failure && <p className="pb-card pb-state pb-muted">{t("playground.empty")}</p>}
          {result && (
            <div className={running ? "pb-answers pb-stale" : "pb-answers"}>
              {Object.entries(result.answers).map(([id, answer]) => (
                <AnswerCard key={id} id={id} answer={answer} trace={result.x_pom?.questions?.[id]} />
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

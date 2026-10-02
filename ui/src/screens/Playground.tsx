import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { usePluginI18n } from "../host/runtime";
import { EXAMPLES } from "../examples";
import {
  ENDPOINT,
  curlFor,
  decide,
  listModels,
  percent,
  ranked,
  type Answer,
  type DecisionRequest,
  type DecisionResponse,
  type QuestionTrace,
  type QuestionType,
} from "../jev";
import {
  LIMITS,
  blankQuestion,
  fromApi,
  move,
  newKey,
  parseState,
  stateIsJson,
  toApi,
  validate,
  type DraftQuestion,
  type Issue,
  type OptionRow,
} from "../builder";

const TYPES: QuestionType[] = ["noul", "choice", "score"];
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
type Selection = "state" | "json" | string;

// ---------------------------------------------------------------- answers
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

function AnswerCard({
  id,
  answer,
  trace,
  active,
  onSelect,
}: {
  id: string;
  answer: Answer;
  trace?: QuestionTrace;
  active: boolean;
  onSelect: () => void;
}) {
  const { t } = usePluginI18n();
  return (
    <article className={active ? "pb-card pb-answer pb-answer-active" : "pb-card pb-answer"}>
      <header className="pb-answer-head">
        <button type="button" className="pb-link" onClick={onSelect}>
          <code className="pb-answer-id">{id}</code>
        </button>
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

// ---------------------------------------------------------------- editors
function RowsEditor({
  rows,
  labelOf,
  withDetail,
  min,
  max,
  addLabel,
  namePlaceholder,
  detailPlaceholder,
  onChange,
}: {
  rows: OptionRow[];
  labelOf: (index: number) => string;
  withDetail: boolean;
  min: number;
  max: number;
  addLabel: string;
  namePlaceholder: string;
  detailPlaceholder?: string;
  onChange: (rows: OptionRow[]) => void;
}) {
  const { t } = usePluginI18n();
  const update = (index: number, patch: Partial<OptionRow>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  return (
    <div className="pb-rows">
      {rows.map((row, index) => (
        <div key={row.key} className={withDetail ? "pb-row pb-row-detail" : "pb-row"}>
          <span className="pb-row-label">{labelOf(index)}</span>
          <input
            className="pb-input pb-mono"
            value={row.name}
            placeholder={namePlaceholder}
            aria-label={namePlaceholder}
            onChange={(event) => update(index, { name: event.target.value })}
          />
          {withDetail && (
            <input
              className="pb-input"
              value={row.detail}
              placeholder={detailPlaceholder}
              aria-label={detailPlaceholder}
              onChange={(event) => update(index, { detail: event.target.value })}
            />
          )}
          <span className="pb-row-actions">
            <button type="button" className="pb-icon" title={t("builder.up")} aria-label={t("builder.up")} disabled={index === 0} onClick={() => onChange(move(rows, index, -1))}>↑</button>
            <button type="button" className="pb-icon" title={t("builder.down")} aria-label={t("builder.down")} disabled={index === rows.length - 1} onClick={() => onChange(move(rows, index, 1))}>↓</button>
            <button type="button" className="pb-icon pb-icon-danger" title={t("builder.remove")} aria-label={t("builder.remove")} disabled={rows.length <= min} onClick={() => onChange(rows.filter((_, i) => i !== index))}>×</button>
          </span>
        </div>
      ))}
      <button
        type="button"
        className="pb-add"
        disabled={rows.length >= max}
        onClick={() => onChange([...rows, { key: newKey(), name: "", detail: "" }])}
      >
        + {addLabel}
      </button>
    </div>
  );
}

function QuestionEditor({
  draft,
  issues,
  onChange,
}: {
  draft: DraftQuestion;
  issues: Issue[];
  onChange: (draft: DraftQuestion) => void;
}) {
  const { t } = usePluginI18n();
  const issueFor = (field: string) => issues.find((issue) => issue.field === field);
  const fieldError = (field: string) => {
    const issue = issueFor(field);
    return issue ? <span className="pb-field-error">{t(`issue.${issue.message}`)}</span> : null;
  };
  return (
    <div className="pb-form">
      <div className="pb-form-grid">
        <label className="pb-form-field">
          <span className="pb-editor-label">{t("builder.id")}</span>
          <input
            className="pb-input pb-mono"
            value={draft.id}
            aria-invalid={!!issueFor("id")}
            onChange={(event) => onChange({ ...draft, id: event.target.value })}
          />
          {fieldError("id")}
        </label>
        <div className="pb-form-field">
          <span className="pb-editor-label">{t("builder.type")}</span>
          <div className="pb-segmented" role="radiogroup" aria-label={t("builder.type")}>
            {TYPES.map((type) => (
              <button
                key={type}
                type="button"
                role="radio"
                aria-checked={draft.type === type}
                className={draft.type === type ? "pb-seg pb-seg-on" : "pb-seg"}
                onClick={() => onChange({ ...draft, type })}
              >
                {type}
              </button>
            ))}
          </div>
        </div>
      </div>
      <p className="pb-hint">{t(`type.${draft.type}`)}</p>

      <label className="pb-form-field">
        <span className="pb-editor-label">{t("builder.instructions")}</span>
        <textarea
          className="pb-input pb-textarea"
          rows={3}
          value={draft.instructions}
          placeholder={t("builder.instructionsPlaceholder")}
          aria-invalid={!!issueFor("instructions")}
          onChange={(event) => onChange({ ...draft, instructions: event.target.value })}
        />
        {fieldError("instructions")}
      </label>

      {draft.type === "noul" && (
        <div className="pb-form-grid">
          <label className="pb-form-field">
            <span className="pb-editor-label">{t("builder.yesWhen")}</span>
            <input className="pb-input" value={draft.yes} placeholder={t("builder.optional")} onChange={(event) => onChange({ ...draft, yes: event.target.value })} />
          </label>
          <label className="pb-form-field">
            <span className="pb-editor-label">{t("builder.noWhen")}</span>
            <input className="pb-input" value={draft.no} placeholder={t("builder.optional")} onChange={(event) => onChange({ ...draft, no: event.target.value })} />
          </label>
        </div>
      )}
      {draft.type === "choice" && (
        <div className="pb-form-field">
          <span className="pb-editor-label">{t("builder.options", { count: draft.options.length })}</span>
          <RowsEditor
            rows={draft.options}
            // The POM labels options in key order (A for the first name).
            labelOf={(index) => {
              const sorted = draft.options.map((option) => option.name.trim()).sort();
              return LETTERS[sorted.indexOf(draft.options[index].name.trim())] ?? "?";
            }}
            withDetail
            min={1}
            max={LIMITS.choice[1]}
            addLabel={t("builder.addOption")}
            namePlaceholder={t("builder.optionName")}
            detailPlaceholder={t("builder.optionDetail")}
            onChange={(options) => onChange({ ...draft, options })}
          />
          {fieldError("options")}
        </div>
      )}
      {draft.type === "score" && (
        <div className="pb-form-field">
          <span className="pb-editor-label">{t("builder.levels", { count: draft.levels.length })}</span>
          <RowsEditor
            rows={draft.levels}
            labelOf={(index) => String(index)}
            withDetail={false}
            min={1}
            max={LIMITS.score[1]}
            addLabel={t("builder.addLevel")}
            namePlaceholder={t("builder.levelName")}
            onChange={(levels) => onChange({ ...draft, levels })}
          />
          {fieldError("levels")}
        </div>
      )}
    </div>
  );
}

/**
 * Copies text. The Clipboard API only exists on HTTPS or localhost, and the
 * POM is usually opened as plain http://<node>:8080, so fall back to a
 * selected textarea and `execCommand("copy")`, which still works there.
 */
async function copy(text: string) {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to the legacy path
    }
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.left = "0";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.focus();
  area.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  area.remove();
  return copied;
}

function stateTextOf(state: unknown): string {
  return typeof state === "string" ? state : JSON.stringify(state, null, 2);
}

// ---------------------------------------------------------------- screen
export function Playground() {
  const { t } = usePluginI18n();
  const [stateText, setStateText] = useState(EXAMPLES[0].state);
  const [drafts, setDrafts] = useState<DraftQuestion[]>(() => fromApi(EXAMPLES[0].questions));
  const [selected, setSelected] = useState<Selection>("state");
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);
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

  const issues = useMemo(() => validate(drafts), [drafts]);
  const stateMissing = !stateText.trim();
  const request: DecisionRequest = useMemo(
    () => ({ ...(model ? { model } : {}), state: parseState(stateText), questions: toApi(drafts) }),
    [model, stateText, drafts],
  );
  const runnable = issues.length === 0 && !stateMissing && !jsonError;

  const run = useCallback(async () => {
    if (!runnable || running) return;
    setRunning(true);
    setFailure(null);
    try {
      setResult(await decide(request));
    } catch (error) {
      setResult(null);
      setFailure((error as Error).message);
    } finally {
      setRunning(false);
    }
  }, [request, runnable, running]);

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
      return true;
    }
    setCopied(`${key}-failed`);
    window.setTimeout(() => setCopied(null), 2400);
    return false;
  };

  const load = (state: unknown, questions: DecisionRequest["questions"]) => {
    setStateText(stateTextOf(state));
    setDrafts(fromApi(questions));
    setResult(null);
    setFailure(null);
    setJsonError(null);
  };

  const loadExample = (id: string) => {
    const example = EXAMPLES.find((item) => item.id === id);
    if (!example) return;
    load(example.state, example.questions);
    setSelected("state");
  };

  const select = (next: Selection) => {
    if (next === "json") {
      setJsonText(JSON.stringify(request, null, 2));
      setJsonError(null);
    }
    setSelected(next);
  };

  const editJson = (text: string) => {
    setJsonText(text);
    try {
      const parsed = JSON.parse(text) as Partial<DecisionRequest>;
      if (!parsed || typeof parsed !== "object" || !parsed.questions || typeof parsed.questions !== "object") {
        throw new Error(t("builder.jsonShape"));
      }
      setStateText(stateTextOf(parsed.state ?? ""));
      setDrafts(fromApi(parsed.questions));
      if (typeof parsed.model === "string") setModel(parsed.model);
      setJsonError(null);
    } catch (error) {
      setJsonError((error as Error).message);
    }
  };

  const addQuestion = (type: QuestionType) => {
    const draft = blankQuestion(type, drafts.map((item) => item.id));
    setDrafts([...drafts, draft]);
    setSelected(draft.key);
  };

  const updateDraft = (next: DraftQuestion) => setDrafts(drafts.map((item) => (item.key === next.key ? next : item)));

  const duplicate = (draft: DraftQuestion) => {
    const copyOf = {
      ...draft,
      key: newKey(),
      id: `${draft.id}_copy`,
      options: draft.options.map((row) => ({ ...row, key: newKey() })),
      levels: draft.levels.map((row) => ({ ...row, key: newKey() })),
    };
    const index = drafts.findIndex((item) => item.key === draft.key);
    setDrafts([...drafts.slice(0, index + 1), copyOf, ...drafts.slice(index + 1)]);
    setSelected(copyOf.key);
  };

  const remove = (draft: DraftQuestion) => {
    const next = drafts.filter((item) => item.key !== draft.key);
    setDrafts(next);
    if (selected === draft.key) setSelected(next[0]?.key ?? "state");
  };

  const current = drafts.find((draft) => draft.key === selected);
  const answerKeyOf = (id: string) => drafts.find((draft) => draft.id.trim() === id)?.key;
  const globalIssues = issues.filter((issue) => issue.key === null);

  return (
    <main className="pb-page pb-ide" onKeyDown={onKey}>
      <header className="pb-ide-bar">
        <div className="pb-ide-brand">
          <span className="pb-ide-logo" aria-hidden="true">J</span>
          <div>
            <h1>{t("playground.title")}</h1>
            <p>{t("playground.subtitle")}</p>
          </div>
        </div>
        <div className="pb-ide-actions">
          <select className="pb-select" defaultValue="" aria-label={t("playground.example")} onChange={(event) => loadExample(event.target.value)}>
            <option value="" disabled>{t("playground.examplePick")}</option>
            {EXAMPLES.map((example) => (
              <option key={example.id} value={example.id}>{t(`example.${example.id}`)}</option>
            ))}
          </select>
          <select className="pb-select" value={model} aria-label={t("playground.model")} onChange={(event) => setModel(event.target.value)}>
            {models.length === 0 && <option value="">{t("playground.modelActive")}</option>}
            {models.map((id) => (
              <option key={id} value={id}>{id}</option>
            ))}
          </select>
          <button
            type="button"
            className="pb-btn pb-btn-outline pb-btn-small"
            onClick={() =>
              void flash("curl", curlFor(request)).then((ok) => {
                // When the browser refuses, show the command to copy by hand.
                if (!ok) select("curl");
              })
            }
          >
            {copied === "curl" ? t("copy.done") : copied === "curl-failed" ? t("copy.failed") : t("copy.curl")}
          </button>
          <button type="button" className="pb-btn pb-btn-accent" disabled={!runnable || running} onClick={() => void run()}>
            {running ? t("playground.running") : t("playground.run")}
            <kbd>Ctrl ↵</kbd>
          </button>
        </div>
      </header>

      <div className="pb-ide-body">
        <nav className="pb-explorer" aria-label={t("explorer.label")}>
          <p className="pb-explorer-title">{t("explorer.request")}</p>
          <button type="button" className={selected === "state" ? "pb-node pb-node-on" : "pb-node"} onClick={() => select("state")}>
            <span className="pb-node-icon" aria-hidden="true">{"{ }"}</span>
            <span className="pb-node-name">state</span>
            <span className="pb-node-meta">{stateIsJson(stateText) ? "json" : "text"}</span>
            {stateMissing && <span className="pb-dot" title={t("issue.noState")} />}
          </button>
          <button type="button" className={selected === "json" ? "pb-node pb-node-on" : "pb-node"} onClick={() => select("json")}>
            <span className="pb-node-icon" aria-hidden="true">{"</>"}</span>
            <span className="pb-node-name">request.json</span>
            {jsonError && <span className="pb-dot" title={jsonError} />}
          </button>
          <button type="button" className={selected === "curl" ? "pb-node pb-node-on" : "pb-node"} onClick={() => select("curl")}>
            <span className="pb-node-icon" aria-hidden="true">$_</span>
            <span className="pb-node-name">curl.sh</span>
          </button>

          <div className="pb-explorer-head">
            <p className="pb-explorer-title">{t("explorer.questions", { count: drafts.length })}</p>
          </div>
          <ul className="pb-tree">
            {drafts.map((draft) => {
              const broken = issues.some((issue) => issue.key === draft.key);
              return (
                <li key={draft.key} className={selected === draft.key ? "pb-tree-item pb-node-on" : "pb-tree-item"}>
                  <button type="button" className="pb-node" onClick={() => select(draft.key)}>
                    <span className={`pb-type pb-type-${draft.type} pb-type-mini`}>{draft.type[0]}</span>
                    <span className="pb-node-name">{draft.id || "?"}</span>
                    {broken && <span className="pb-dot" title={t("explorer.hasIssues")} />}
                  </button>
                  <span className="pb-tree-actions">
                    <button type="button" className="pb-icon" title={t("builder.duplicate")} aria-label={t("builder.duplicate")} onClick={() => duplicate(draft)}>⧉</button>
                    <button type="button" className="pb-icon pb-icon-danger" title={t("builder.remove")} aria-label={t("builder.remove")} onClick={() => remove(draft)}>×</button>
                  </span>
                </li>
              );
            })}
          </ul>
          <div className="pb-add-group">
            <span className="pb-editor-label">{t("explorer.add")}</span>
            <div className="pb-add-buttons">
              {TYPES.map((type) => (
                <button key={type} type="button" className={`pb-add-type pb-type-${type}`} disabled={drafts.length >= LIMITS.questions} onClick={() => addQuestion(type)}>
                  + {type}
                </button>
              ))}
            </div>
          </div>
        </nav>

        <section className="pb-pane pb-pane-editor">
          <div className="pb-tabbar">
            <span className="pb-tab pb-tab-on">
              {selected === "state"
                ? "state"
                : selected === "json"
                  ? "request.json"
                  : selected === "curl"
                    ? "curl.sh"
                    : current?.id || "?"}
            </span>
            {current && <span className={`pb-type pb-type-${current.type}`}>{current.type}</span>}
          </div>
          <div className="pb-pane-scroll">
            {selected === "state" && (
              <div className="pb-fill">
                <p className="pb-hint">{t("playground.stateHint")}</p>
                <textarea
                  className="pb-code-input"
                  spellCheck={false}
                  value={stateText}
                  aria-label={t("playground.state")}
                  onChange={(event) => setStateText(event.target.value)}
                />
              </div>
            )}
            {selected === "json" && (
              <div className="pb-fill">
                <p className={jsonError ? "pb-hint pb-hint-error" : "pb-hint"}>
                  {jsonError ? t("playground.invalid", { error: jsonError }) : t("builder.jsonHint")}
                </p>
                <textarea
                  className="pb-code-input"
                  spellCheck={false}
                  value={jsonText}
                  aria-label="request.json"
                  aria-invalid={!!jsonError}
                  onChange={(event) => editJson(event.target.value)}
                />
              </div>
            )}
            {selected === "curl" && (
              <div className="pb-fill">
                <div className="pb-curl-head">
                  <p className="pb-hint">{t("curl.hint")}</p>
                  <button type="button" className="pb-btn pb-btn-outline pb-btn-small" onClick={() => void flash("curl-view", curlFor(request))}>
                    {copied === "curl-view" ? t("copy.done") : copied === "curl-view-failed" ? t("copy.failed") : t("copy.curl")}
                  </button>
                </div>
                <textarea
                  className="pb-code-input"
                  readOnly
                  spellCheck={false}
                  value={curlFor(request)}
                  aria-label="curl.sh"
                  onFocus={(event) => event.currentTarget.select()}
                />
              </div>
            )}
            {current && (
              <QuestionEditor
                draft={current}
                issues={issues.filter((issue) => issue.key === current.key)}
                onChange={updateDraft}
              />
            )}
          </div>
        </section>

        <section className="pb-pane pb-pane-output" aria-live="polite">
          <div className="pb-tabbar">
            <span className="pb-tab pb-tab-on">{t("playground.response")}</span>
            {result && (
              <button type="button" className="pb-btn pb-btn-outline pb-btn-small" onClick={() => void flash("json", JSON.stringify(result, null, 2))}>
                {copied === "json" ? t("copy.done") : copied === "json-failed" ? t("copy.failed") : t("copy.json")}
              </button>
            )}
          </div>
          <div className="pb-pane-scroll">
            {running && !result && <p className="pb-card pb-state pb-pulse">{t("playground.running")}</p>}
            {failure && <p className="pb-card pb-state pb-error" role="alert">{failure}</p>}
            {!running && !result && !failure && <p className="pb-empty-state">{t("playground.empty")}</p>}
            {result && (
              <div className={running ? "pb-answers pb-stale" : "pb-answers"}>
                {Object.entries(result.answers).map(([id, answer]) => (
                  <AnswerCard
                    key={id}
                    id={id}
                    answer={answer}
                    trace={result.x_pom?.questions?.[id]}
                    active={answerKeyOf(id) === selected}
                    onSelect={() => {
                      const key = answerKeyOf(id);
                      if (key) select(key);
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        </section>
      </div>

      <footer className="pb-statusbar">
        <span className={runnable ? "pb-status-ok" : "pb-status-bad"}>
          {runnable
            ? t("status.ready")
            : stateMissing
              ? t("issue.noState")
              : jsonError
                ? t("status.jsonError")
                : globalIssues[0]
                  ? t(`issue.${globalIssues[0].message}`)
                  : t("status.issues", { count: issues.length })}
        </span>
        <span>{t("status.questions", { count: drafts.length })}</span>
        <span className="pb-mono">POST {ENDPOINT}</span>
        <span className="pb-mono">{result?.model ?? (model || t("playground.modelActive"))}</span>
        {result?.x_pom?.duration_ms !== undefined && <span className="pb-mono">{result.x_pom.duration_ms} ms</span>}
        {result?.usage && <span className="pb-mono">{t("status.tokens", { count: result.usage.input_tokens })}</span>}
      </footer>
    </main>
  );
}

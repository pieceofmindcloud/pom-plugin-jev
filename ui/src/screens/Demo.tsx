import { useCallback, useEffect, useRef, useState } from "react";
import { usePluginI18n } from "../host/runtime";
import { decide, listModels, percent, ranked } from "../jev";
import { burst, drawScene, type Particle } from "../snakeArt";
import {
  DIRECTIONS,
  checkMove,
  decisionState,
  moveQuestion,
  newGame,
  step,
  tickForScore,
  type Cell,
  type Direction,
  type Game,
} from "../snake";

type Pilot = "jev" | "human";

type Decision = {
  move: number;
  dir: Direction;
  forced: boolean;
  probabilities: Record<string, number>;
  confidence?: number;
  ms: number;
  score: number;
};

const MAX_LOG = 40;
const KEYMAP: Record<string, Direction> = {
  arrowup: "up",
  arrowdown: "down",
  arrowleft: "left",
  arrowright: "right",
  w: "up",
  s: "down",
  a: "left",
  d: "right",
};
const ARROWS: Record<Direction, string> = { up: "▲", down: "▼", left: "◀", right: "▶" };

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (ms <= 0 || signal.aborted) return resolve();
    const timer = window.setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      window.clearTimeout(timer);
      resolve();
    });
  });

// ---------------------------------------------------------------- screen
export function Demo() {
  const { t } = usePluginI18n();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [boardSize, setBoardSize] = useState(0);
  const gameRef = useRef<Game>(newGame());
  const hintRef = useRef<Direction | null>(null);
  // Animation state: where the snake was, when it moved, how long the slide
  // lasts, the eat bursts and when the game ended.
  const previousRef = useRef<Cell[] | null>(null);
  const movedAtRef = useRef(0);
  const slideMsRef = useRef(120);
  const particlesRef = useRef<Particle[]>([]);
  const deadAtRef = useRef<number | null>(null);
  const humanDir = useRef<Direction>("right");
  const abortRef = useRef<AbortController | null>(null);
  const [, setVersion] = useState(0);
  const [pilot, setPilot] = useState<Pilot>("jev");
  const [running, setRunning] = useState(false);
  const [guard, setGuard] = useState(true);
  const [hints, setHints] = useState(true);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState("");
  const [log, setLog] = useState<Decision[]>([]);
  const [best, setBest] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [lastRequest, setLastRequest] = useState<unknown>(null);

  const game = gameRef.current;
  const render = () => setVersion((value) => value + 1);

  useEffect(() => {
    listModels()
      .then((ids) => {
        setModels(ids);
        setModel((current) => current || ids[0] || "");
      })
      .catch(() => setModels([]));
  }, []);

  // Paint every frame (the banana pulses); the game itself moves in turns.
  useEffect(() => {
    let frame = 0;
    const paint = (now: number) => {
      const canvas = canvasRef.current;
      const holder = frameRef.current;
      if (canvas && holder) {
        // The board is the largest square that fits the stage, so the screen
        // never scrolls whatever the window size.
        const size = Math.max(120, Math.floor(Math.min(holder.clientWidth, holder.clientHeight || holder.clientWidth)));
        setBoardSize((current) => (current === size ? current : size));
        const dpr = window.devicePixelRatio || 1;
        if (canvas.width !== Math.round(size * dpr)) {
          canvas.width = Math.round(size * dpr);
          canvas.height = Math.round(size * dpr);
          canvas.style.width = `${size}px`;
          canvas.style.height = `${size}px`;
        }
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          drawScene(ctx, size, dpr, {
            game: gameRef.current,
            previous: previousRef.current,
            progress: (now - movedAtRef.current) / slideMsRef.current,
            now,
            hint: hintRef.current,
            particles: particlesRef.current,
            deadFor: deadAtRef.current === null ? null : now - deadAtRef.current,
          });
        }
      }
      frame = requestAnimationFrame(paint);
    };
    frame = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  /** Moves to the next position and starts the slide (and a burst on eating). */
  const advance = useCallback((next: Game) => {
    const before = gameRef.current;
    previousRef.current = before.snake;
    movedAtRef.current = performance.now();
    slideMsRef.current = Math.max(60, Math.min(tickForScore(next.score), 160));
    if (next.score > before.score && before.food) burst(before.food, particlesRef.current);
    gameRef.current = next;
  }, []);

  const finish = useCallback((next: Game) => {
    deadAtRef.current = performance.now();
    gameRef.current = next;
    hintRef.current = null;
    setBest((value) => Math.max(value, next.score));
    render();
  }, []);

  const jevLoop = useCallback(
    async (signal: AbortSignal) => {
      while (!signal.aborted && gameRef.current.status === "playing") {
        const current = gameRef.current;
        const started = performance.now();
        const safe = DIRECTIONS.filter((dir) => !checkMove(current, dir).fatal);
        let choice: Direction;
        let entry: Omit<Decision, "dir" | "ms">;
        // No choice to make: JEV is not asked. Zero safe moves ends the game;
        // one safe move is played directly, with or without the guard.
        if (safe.length === 0) {
          finish({ ...current, status: "over", cause: "trapped" });
          break;
        }
        if (safe.length === 1) {
          choice = safe[0];
          entry = { move: current.moves + 1, forced: true, probabilities: { [choice]: 1 }, score: current.score };
        } else {
          const request = {
            ...(model ? { model } : {}),
            state: decisionState(current),
            questions: { move: moveQuestion(current, { guard, hints }) },
          };
          setLastRequest(request);
          try {
            const response = await decide(request, signal);
            const answer = response.answers.move;
            if (!answer || answer.type !== "choice") throw new Error(t("demo.badAnswer"));
            choice = answer.choice as Direction;
            entry = {
              move: current.moves + 1,
              forced: false,
              probabilities: answer.probabilities,
              confidence: answer.confidence,
              score: current.score,
            };
          } catch (failure) {
            if (signal.aborted) break;
            setError((failure as Error).message);
            setRunning(false);
            break;
          }
        }
        if (signal.aborted) break;
        hintRef.current = choice;
        const ms = Math.round(performance.now() - started);
        setLog((items) => [{ ...entry, dir: choice, ms }, ...items].slice(0, MAX_LOG));
        const next = step(current, choice);
        if (next.status === "over") {
          finish(next);
          break;
        }
        advance(next);
        setBest((value) => Math.max(value, next.score));
        render();
        // Never faster than the original game's speed for this score.
        await wait(tickForScore(next.score) - (performance.now() - started), signal);
      }
      setRunning(false);
    },
    [advance, finish, guard, hints, model, t],
  );

  const humanLoop = useCallback(
    async (signal: AbortSignal) => {
      while (!signal.aborted && gameRef.current.status === "playing") {
        await wait(tickForScore(gameRef.current.score), signal);
        if (signal.aborted) break;
        const next = step(gameRef.current, humanDir.current);
        if (next.status === "over") {
          finish(next);
          break;
        }
        advance(next);
        setBest((value) => Math.max(value, next.score));
        render();
      }
      setRunning(false);
    },
    [advance, finish],
  );

  const start = (fresh: boolean) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    if (fresh || gameRef.current.status !== "playing") {
      gameRef.current = { ...newGame(), status: "playing" };
      previousRef.current = null;
      particlesRef.current = [];
      deadAtRef.current = null;
      humanDir.current = "right";
      setLog([]);
    }
    hintRef.current = null;
    setError(null);
    setRunning(true);
    render();
    void (pilot === "jev" ? jevLoop(controller.signal) : humanLoop(controller.signal));
  };

  const stop = () => {
    abortRef.current?.abort();
    setRunning(false);
  };

  useEffect(() => {
    if (pilot !== "human") return;
    const onKey = (event: KeyboardEvent) => {
      const dir = KEYMAP[event.key.toLowerCase()];
      if (!dir) return;
      event.preventDefault();
      const current = gameRef.current;
      if (current.status === "playing" && dir !== current.dir && checkMove(current, dir).fatal !== "reverse") {
        humanDir.current = dir;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pilot]);

  const switchPilot = (next: Pilot) => {
    stop();
    setPilot(next);
  };

  const asked = log.filter((entry) => !entry.forced);
  const avgMs = asked.length ? Math.round(asked.reduce((sum, entry) => sum + entry.ms, 0) / asked.length) : null;
  const avgConfidence = asked.length
    ? asked.reduce((sum, entry) => sum + (entry.confidence ?? 0), 0) / asked.length
    : null;
  const latest = log[0];

  return (
    <main className="pb-page pb-ide">
      <header className="pb-ide-bar">
        <div className="pb-ide-brand">
          <span className="pb-ide-logo" aria-hidden="true">J</span>
          <div>
            <h1>{t("demo.title")}</h1>
            <p>{t("demo.body")}</p>
          </div>
        </div>
        <div className="pb-ide-actions">
          <div className="pb-segmented" role="radiogroup" aria-label={t("demo.pilot")}>
            {(["jev", "human"] as Pilot[]).map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={pilot === value}
                className={pilot === value ? "pb-seg pb-seg-on" : "pb-seg"}
                onClick={() => switchPilot(value)}
              >
                {t(`demo.pilot.${value}`)}
              </button>
            ))}
          </div>
          {pilot === "jev" && (
            <label className="pb-field pb-field-inline">
              <span>{t("playground.model")}</span>
              <select className="pb-select" value={model} disabled={running} onChange={(event) => setModel(event.target.value)}>
                {models.length === 0 && <option value="">{t("playground.modelActive")}</option>}
                {models.map((id) => (
                  <option key={id} value={id}>{id}</option>
                ))}
              </select>
            </label>
          )}
        </div>
      </header>

      <div className="pb-demo-grid">
        <section className="pb-arena">
          <div className="pb-scorebar">
            <div className="pb-score"><span>{t("demo.score")}</span><strong>{game.score}</strong></div>
            <div className="pb-score"><span>{t("demo.moves")}</span><strong>{game.moves}</strong></div>
            <div className="pb-score"><span>{t("demo.best")}</span><strong>{best}</strong></div>
          </div>
          <div className="pb-stage" ref={frameRef}>
          <div className="pb-board" style={boardSize ? { width: boardSize, height: boardSize } : undefined}>
            <canvas ref={canvasRef} aria-label={t("demo.boardLabel")} role="img" />
            {!running && (
              <div className="pb-overlay">
                <div className="pb-overlay-card">
                  <h2>
                    {game.status === "over"
                      ? t("demo.over")
                      : game.status === "playing"
                        ? t("demo.paused")
                        : t("demo.ready")}
                  </h2>
                  <p>
                    {game.status === "over"
                      ? t(`demo.cause.${game.cause ?? "body"}`, { score: game.score })
                      : pilot === "jev"
                        ? t("demo.readyJev")
                        : t("demo.readyHuman")}
                  </p>
                  {error && <p className="pb-error-text" role="alert">{error}</p>}
                  <div className="pb-btn-row pb-center">
                    {game.status === "playing" && (
                      <button type="button" className="pb-btn pb-btn-accent" onClick={() => start(false)}>
                        {t("demo.resume")}
                      </button>
                    )}
                    <button
                      type="button"
                      className={game.status === "playing" ? "pb-btn pb-btn-outline" : "pb-btn pb-btn-accent"}
                      onClick={() => start(true)}
                    >
                      {game.status === "over" ? t("demo.again") : t("demo.start")}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
          </div>
          <div className="pb-btn-row">
            <button type="button" className="pb-btn pb-btn-outline pb-btn-small" disabled={!running} onClick={stop}>
              {t("demo.pause")}
            </button>
            {pilot === "jev" && (
              <>
                <label className="pb-check">
                  <input type="checkbox" checked={guard} disabled={running} onChange={(event) => setGuard(event.target.checked)} />
                  <span>{t("demo.guard")}</span>
                </label>
                <label className="pb-check">
                  <input type="checkbox" checked={hints} disabled={running} onChange={(event) => setHints(event.target.checked)} />
                  <span>{t("demo.hints")}</span>
                </label>
              </>
            )}
          </div>
          {pilot === "human" && <p className="pb-hint">{t("demo.keys")}</p>}
        </section>

        <aside className="pb-side">
          <div className="pb-card pb-live">
            <span className="pb-editor-label">{t("demo.latest")}</span>
            {latest ? (
              <>
                <p className="pb-live-move">
                  <span aria-hidden="true">{ARROWS[latest.dir]}</span> {latest.dir}
                  {latest.forced && <small>{t("demo.forced")}</small>}
                </p>
                <ul className="pb-bars">
                  {ranked(latest.probabilities).map(([dir, value]) => (
                    <li key={dir} className={dir === latest.dir ? "pb-bar pb-bar-win" : "pb-bar"}>
                      <span className="pb-bar-label">{dir}</span>
                      <span className="pb-bar-track" aria-hidden="true">
                        <span className="pb-bar-fill" style={{ width: `${Math.max(value * 100, 0.5)}%` }} />
                      </span>
                      <span className="pb-bar-value">{percent(value)}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="pb-muted">{pilot === "jev" ? t("demo.waiting") : t("demo.humanNoLog")}</p>
            )}
            <dl className="pb-stats">
              <div><dt>{t("demo.asked")}</dt><dd>{asked.length}</dd></div>
              <div><dt>{t("demo.latency")}</dt><dd>{avgMs === null ? "-" : `${avgMs} ms`}</dd></div>
              <div><dt>{t("answer.confidence")}</dt><dd>{avgConfidence === null ? "-" : percent(avgConfidence)}</dd></div>
            </dl>
          </div>

          <div className="pb-card pb-log">
            <span className="pb-editor-label">{t("demo.log")}</span>
            <ol>
              {log.map((entry) => (
                <li key={entry.move}>
                  <span className="pb-log-move">#{entry.move}</span>
                  <span className="pb-log-dir">{ARROWS[entry.dir]} {entry.dir}</span>
                  <span className="pb-log-meta">
                    {entry.forced ? t("demo.forced") : `${percent(entry.probabilities[entry.dir] ?? 0)} · ${entry.ms} ms`}
                  </span>
                </li>
              ))}
            </ol>
          </div>

          {lastRequest !== null && (
            <details className="pb-card pb-request">
              <summary>{t("demo.request")}</summary>
              <pre>{JSON.stringify(lastRequest, null, 2)}</pre>
            </details>
          )}
        </aside>
      </div>
    </main>
  );
}

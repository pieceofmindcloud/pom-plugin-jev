import { useCallback, useEffect, useRef, useState } from "react";
import { usePluginI18n } from "../host/runtime";
import { decide, listModels, percent, ranked } from "../jev";
import {
  DIRECTIONS,
  DIRS,
  GRID,
  checkMove,
  decisionState,
  moveQuestion,
  newGame,
  step,
  tickForScore,
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

// ---------------------------------------------------------------- drawing
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawGame(ctx: CanvasRenderingContext2D, size: number, game: Game, now: number, hint: Direction | null) {
  const s = size / GRID;
  ctx.clearRect(0, 0, size, size);
  const board = ctx.createLinearGradient(0, 0, 0, size);
  board.addColorStop(0, "#1c2745");
  board.addColorStop(1, "#131c30");
  ctx.fillStyle = board;
  roundRect(ctx, 0, 0, size, size, s * 0.6);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,.02)";
  for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) if ((x + y) % 2 === 1) ctx.fillRect(x * s, y * s, s, s);

  if (game.food) {
    const pulse = 0.5 + 0.5 * Math.sin(now / 280);
    const cx = (game.food.x + 0.5) * s;
    const cy = (game.food.y + 0.5) * s;
    ctx.save();
    const halo = ctx.createRadialGradient(cx, cy, s * 0.12, cx, cy, s * (0.7 + 0.15 * pulse));
    halo.addColorStop(0, "rgba(255,214,90,.38)");
    halo.addColorStop(1, "rgba(255,214,90,0)");
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(cx, cy, s * (0.7 + 0.15 * pulse), 0, Math.PI * 2);
    ctx.fill();
    const bw = s * 0.64;
    const bh = s * 0.4;
    ctx.translate(cx, cy);
    ctx.rotate(-Math.PI / 5 + pulse * 0.08);
    const banana = ctx.createLinearGradient(0, -bh, 0, bh);
    banana.addColorStop(0, "#ffe27a");
    banana.addColorStop(0.5, "#ffd24d");
    banana.addColorStop(1, "#f2b93c");
    ctx.fillStyle = banana;
    ctx.beginPath();
    ctx.moveTo(-bw / 2, -bh * 0.15);
    ctx.quadraticCurveTo(0, -bh * 1.4, bw / 2, -bh * 0.15);
    ctx.quadraticCurveTo(bw * 0.46, bh * 0.78, 0, bh * 0.92);
    ctx.quadraticCurveTo(-bw * 0.46, bh * 0.78, -bw / 2, -bh * 0.15);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#9a7b33";
    ctx.beginPath();
    ctx.arc(-bw / 2, -bh * 0.15, s * 0.08, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  const snake = game.snake;
  if (!snake.length) return;
  const path = (offset: number) => {
    ctx.beginPath();
    snake.forEach((cell, index) => {
      const px = (cell.x + 0.5) * s + offset;
      const py = (cell.y + 0.5) * s + offset;
      if (index === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
  };
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(0,0,0,.25)";
  ctx.lineWidth = s;
  path(s * 0.16);
  ctx.stroke();
  const head = snake[0];
  const tail = snake[snake.length - 1];
  const body = ctx.createLinearGradient((head.x + 0.5) * s, (head.y + 0.5) * s, (tail.x + 0.5) * s, (tail.y + 0.5) * s);
  body.addColorStop(0, "#8ff5c4");
  body.addColorStop(0.35, "#4fe6a1");
  body.addColorStop(1, "#2bbf7e");
  ctx.strokeStyle = body;
  ctx.lineWidth = s * 0.8;
  path(0);
  ctx.stroke();
  ctx.strokeStyle = "rgba(255,255,255,.16)";
  ctx.lineWidth = s * 0.24;
  path(-s * 0.13);
  ctx.stroke();

  // Where JEV is about to go.
  if (hint) {
    const to = { x: head.x + DIRS[hint].x, y: head.y + DIRS[hint].y };
    ctx.save();
    ctx.strokeStyle = "rgba(143,245,196,.55)";
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    roundRect(ctx, to.x * s + 2, to.y * s + 2, s - 4, s - 4, s * 0.25);
    ctx.stroke();
    ctx.restore();
  }

  const cx = (head.x + 0.5) * s;
  const cy = (head.y + 0.5) * s;
  const r = s * 0.48;
  const skull = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.4, r * 0.15, cx, cy, r);
  skull.addColorStop(0, "#aef8d6");
  skull.addColorStop(0.7, "#5fe9ab");
  skull.addColorStop(1, "#34c98b");
  ctx.fillStyle = skull;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  const d = DIRS[game.dir];
  const eyeOff = r * 0.45;
  const fwd = r * 0.32;
  const px = -d.y;
  const py = d.x;
  for (const sign of [1, -1]) {
    const ex = cx + d.x * fwd + sign * px * eyeOff;
    const ey = cy + d.y * fwd + sign * py * eyeOff;
    ctx.fillStyle = "#f6fffb";
    ctx.beginPath();
    ctx.arc(ex, ey, r * 0.34, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#0c2a1d";
    ctx.beginPath();
    ctx.arc(ex + d.x * r * 0.18, ey + d.y * r * 0.18, r * 0.17, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ---------------------------------------------------------------- screen
export function Demo() {
  const { t } = usePluginI18n();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Game>(newGame());
  const hintRef = useRef<Direction | null>(null);
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
        const size = Math.max(1, Math.floor(Math.min(holder.clientWidth, holder.clientHeight || holder.clientWidth)));
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
          drawGame(ctx, size, gameRef.current, now, hintRef.current);
        }
      }
      frame = requestAnimationFrame(paint);
    };
    frame = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  const finish = useCallback((next: Game) => {
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
        if (guard && safe.length === 0) {
          finish({ ...current, status: "over", cause: "trapped" });
          break;
        }
        if (guard && safe.length === 1) {
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
        gameRef.current = next;
        setBest((value) => Math.max(value, next.score));
        render();
        // Never faster than the original game's speed for this score.
        await wait(tickForScore(next.score) - (performance.now() - started), signal);
      }
      setRunning(false);
    },
    [finish, guard, hints, model, t],
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
        gameRef.current = next;
        setBest((value) => Math.max(value, next.score));
        render();
      }
      setRunning(false);
    },
    [finish],
  );

  const start = (fresh: boolean) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    if (fresh || gameRef.current.status !== "playing") {
      gameRef.current = { ...newGame(), status: "playing" };
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
    <main className="pb-page">
      <header className="pb-head">
        <div>
          <p className="pb-eyebrow"><span className="pb-tick" aria-hidden="true" />{t("demo.eyebrow")}</p>
          <h1 className="pb-title">{t("demo.title")}</h1>
          <p className="pb-lede">{t("demo.body")}</p>
        </div>
        <div className="pb-toolbar">
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
            <label className="pb-field">
              <span>{t("playground.model")}</span>
              <select value={model} disabled={running} onChange={(event) => setModel(event.target.value)}>
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
          <div className="pb-board" ref={frameRef}>
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

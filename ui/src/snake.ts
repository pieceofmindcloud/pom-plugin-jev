/** Snake rules, kept apart from drawing so the JEV loop can reason about moves. */

export const GRID = 20;
export const BASE_TICK_MS = 165;

export type Direction = "up" | "down" | "left" | "right";
export type Cell = { x: number; y: number };

export const DIRECTIONS: Direction[] = ["up", "down", "left", "right"];
export const DIRS: Record<Direction, Cell> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};
export const OPPOSITE: Record<Direction, Direction> = { up: "down", down: "up", left: "right", right: "left" };

export type Game = {
  snake: Cell[];
  dir: Direction;
  food: Cell | null;
  score: number;
  moves: number;
  status: "ready" | "playing" | "over";
  cause?: "wall" | "body" | "trapped";
};

const keyOf = (cell: Cell) => `${cell.x},${cell.y}`;
const inBounds = (cell: Cell) => cell.x >= 0 && cell.y >= 0 && cell.x < GRID && cell.y < GRID;

export function placeFood(snake: Cell[], random: () => number = Math.random): Cell | null {
  const occupied = new Set(snake.map(keyOf));
  const free: Cell[] = [];
  for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) if (!occupied.has(`${x},${y}`)) free.push({ x, y });
  return free.length ? free[Math.floor(random() * free.length)] : null;
}

export function newGame(random: () => number = Math.random): Game {
  const midY = Math.floor(GRID / 2);
  const snake = [{ x: 5, y: midY }, { x: 4, y: midY }, { x: 3, y: midY }];
  return { snake, dir: "right", food: placeFood(snake, random), score: 0, moves: 0, status: "ready" };
}

/** Speed rises slowly with the score, with a ceiling to stay watchable. */
export const tickForScore = (score: number) => BASE_TICK_MS / Math.min(1 + score * 0.011, 2.5);

export type MoveCheck = { dir: Direction; to: Cell; fatal: false | "wall" | "body" | "reverse"; eats: boolean };

/** What one move does from this position, before it is played. */
export function checkMove(game: Game, dir: Direction): MoveCheck {
  const head = game.snake[0];
  const to = { x: head.x + DIRS[dir].x, y: head.y + DIRS[dir].y };
  const eats = !!game.food && to.x === game.food.x && to.y === game.food.y;
  if (dir === OPPOSITE[game.dir]) return { dir, to, fatal: "reverse", eats: false };
  if (!inBounds(to)) return { dir, to, fatal: "wall", eats };
  // The tail leaves its cell this step unless the snake eats.
  const body = eats ? game.snake : game.snake.slice(0, -1);
  if (body.some((cell) => cell.x === to.x && cell.y === to.y)) return { dir, to, fatal: "body", eats };
  return { dir, to, fatal: false, eats };
}

/** Plays one move and returns the next game; a fatal move ends it. */
export function step(game: Game, wanted: Direction, random: () => number = Math.random): Game {
  const dir = wanted === OPPOSITE[game.dir] ? game.dir : wanted;
  const check = checkMove(game, dir);
  if (check.fatal) {
    return { ...game, dir, status: "over", cause: check.fatal === "reverse" ? "body" : check.fatal };
  }
  const snake = [check.to, ...game.snake];
  if (!check.eats) snake.pop();
  return {
    ...game,
    snake,
    dir,
    moves: game.moves + 1,
    score: check.eats ? game.score + 10 : game.score,
    food: check.eats ? placeFood(snake, random) : game.food,
    status: "playing",
  };
}

/** Cells the head can still reach after a move (flood fill), a trap detector. */
export function reachableAfter(game: Game, dir: Direction): number {
  const check = checkMove(game, dir);
  if (check.fatal) return 0;
  const snake = [check.to, ...game.snake];
  if (!check.eats) snake.pop();
  const blocked = new Set(snake.slice(1).map(keyOf));
  const seen = new Set([keyOf(check.to)]);
  const queue = [check.to];
  while (queue.length) {
    const cell = queue.shift()!;
    for (const d of DIRECTIONS) {
      const next = { x: cell.x + DIRS[d].x, y: cell.y + DIRS[d].y };
      const key = keyOf(next);
      if (!inBounds(next) || blocked.has(key) || seen.has(key)) continue;
      seen.add(key);
      queue.push(next);
    }
  }
  return seen.size - 1;
}

const distance = (a: Cell, b: Cell) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/** The state JEV reads: positions only, no image. */
const STEP_LETTER: Record<string, string> = { "0,-1": "U", "0,1": "D", "-1,0": "L", "1,0": "R" };

/**
 * The body as run-length steps from the head: `"L4 D2"` means the next four
 * segments go left of the head, then two go down. It describes exactly the
 * same cells as a coordinate list for a fraction of the tokens: a 63-segment
 * snake is a few runs instead of ~450 tokens of `[x,y]` pairs.
 */
export function bodySteps(snake: Cell[]): string {
  const runs: [string, number][] = [];
  for (let i = 1; i < snake.length; i++) {
    const letter = STEP_LETTER[`${snake[i].x - snake[i - 1].x},${snake[i].y - snake[i - 1].y}`] ?? "?";
    const last = runs[runs.length - 1];
    if (last && last[0] === letter) last[1] += 1;
    else runs.push([letter, 1]);
  }
  return runs.map(([letter, count]) => `${letter}${count}`).join(" ");
}

/** The state JEV reads: positions only, no image, as few tokens as possible. */
export function decisionState(game: Game) {
  const head = game.snake[0];
  return {
    board: `${GRID}x${GRID}; x grows right, y grows down, (0,0) top-left`,
    head: [head.x, head.y],
    moving: game.dir,
    body: bodySteps(game.snake),
    body_format: "run-length steps from the head: U up, D down, L left, R right",
    length: game.snake.length,
    food: game.food ? [game.food.x, game.food.y] : null,
  };
}

/** One candidate path of 1 to 3 moves, already simulated. */
export type PathOption = {
  name: string;
  moves: Direction[];
  /** Where the path ends (for a fatal path, the position before dying). */
  end: Game;
  fatal: false | "wall" | "body";
  /** Move (1-based) at which the snake eats, if it does. */
  eatsAt: number | null;
  /** The path stops early because no safe move follows. */
  trapped: boolean;
};

export const MAX_OPTIONS = 26;
const noFood = () => 0;

/**
 * Every path of up to `depth` moves from this position. A path stops early
 * when it eats (the next food is random, so nothing after it is known) or
 * when no safe move follows. With the guard on, paths that die are not
 * offered. At most 26 options (the POM's choice limit), best first.
 */
export function enumeratePaths(game: Game, depth: number, guard: boolean): PathOption[] {
  const out: PathOption[] = [];
  const walk = (current: Game, moves: Direction[], eatsAt: number | null) => {
    let extended = false;
    for (const dir of DIRECTIONS) {
      const check = checkMove(current, dir);
      if (check.fatal === "reverse") continue;
      const path = [...moves, dir];
      if (check.fatal) {
        if (!guard) out.push({ name: path.join("-"), moves: path, end: current, fatal: check.fatal, eatsAt, trapped: false });
        extended = extended || !guard;
        continue;
      }
      extended = true;
      const next = step(current, dir, noFood);
      const ate = check.eats ? path.length : eatsAt;
      if (check.eats || path.length >= depth) {
        out.push({ name: path.join("-"), moves: path, end: next, fatal: false, eatsAt: ate, trapped: false });
      } else {
        walk(next, path, ate);
      }
    }
    if (!extended && moves.length > 0) {
      out.push({ name: moves.join("-"), moves, end: current, fatal: false, eatsAt, trapped: true });
    }
  };
  walk(game, [], null);
  const food = game.food;
  const score = (option: PathOption) => {
    if (option.fatal) return 3_000_000;
    if (option.trapped) return 2_000_000;
    const room = reachableRoom(option.end);
    const tight = room < option.end.snake.length ? 1_000_000 : 0;
    const eat = option.eatsAt !== null ? -10_000 + option.eatsAt * 100 : 0;
    const head = option.end.snake[0];
    const dist = food && option.eatsAt === null ? distance(head, food) * 10 : 0;
    return tight + eat + dist - Math.min(room, 99) / 100;
  };
  return out.sort((a, b) => score(a) - score(b)).slice(0, MAX_OPTIONS);
}

/** Free cells the head of this position can reach. */
function reachableRoom(game: Game): number {
  const blocked = new Set(game.snake.slice(1).map(keyOf));
  const start = game.snake[0];
  const seen = new Set([keyOf(start)]);
  const queue = [start];
  while (queue.length) {
    const cell = queue.shift()!;
    for (const d of DIRECTIONS) {
      const next = { x: cell.x + DIRS[d].x, y: cell.y + DIRS[d].y };
      const key = keyOf(next);
      if (!inBounds(next) || blocked.has(key) || seen.has(key)) continue;
      seen.add(key);
      queue.push(next);
    }
  }
  return seen.size - 1;
}

function describePath(game: Game, option: PathOption): string {
  if (option.fatal) {
    const at = option.moves.length;
    return option.fatal === "wall" ? `hits the wall at move ${at} and dies` : `bites its own body at move ${at} and dies`;
  }
  const head = option.end.snake[0];
  const parts = [`head ends at (${head.x},${head.y})`];
  if (option.eatsAt !== null) parts.push(`eats the food at move ${option.eatsAt}`);
  else if (game.food) parts.push(`food distance becomes ${distance(head, game.food)} (now ${distance(game.snake[0], game.food)})`);
  if (option.trapped) parts.push("then no safe move: a trap");
  else {
    const room = reachableRoom(option.end);
    parts.push(room < option.end.snake.length ? `only ${room} free cells reachable afterwards: a trap` : `${room} free cells reachable afterwards`);
  }
  return parts.join("; ");
}

/** The `plan` question over the given paths (option names like `up-left`). */
export function planQuestion(game: Game, options: PathOption[], depth: number, hints: boolean) {
  const criteria: Record<string, string | null> = {};
  for (const option of options) criteria[option.name] = hints ? describePath(game, option) : null;
  const goal =
    "reach the food as fast as possible, never hit a wall or the snake's own body, and avoid paths that leave too little free space.";
  return {
    type: "choice" as const,
    instructions:
      depth <= 1
        ? `You steer the snake. Pick the next move: ${goal}`
        : `You steer the snake. Pick the next moves as one path (up to ${depth} moves, separated by '-'; a path stops early where the snake eats): ${goal}`,
    criteria,
  };
}

/** Position and food as a key: a prefetched plan is only used for the same position. */
export const positionKey = (game: Game) => JSON.stringify([game.snake, game.food, game.dir]);

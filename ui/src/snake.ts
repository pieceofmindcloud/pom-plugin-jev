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
export function decisionState(game: Game) {
  const head = game.snake[0];
  return {
    game: "snake",
    board: { width: GRID, height: GRID, coordinates: "x grows to the right, y grows downwards, (0,0) is the top-left cell" },
    snake: {
      head: [head.x, head.y],
      body: game.snake.slice(1).map((cell) => [cell.x, cell.y]),
      length: game.snake.length,
      moving: game.dir,
    },
    food: game.food ? [game.food.x, game.food.y] : null,
    score: game.score,
  };
}

/**
 * The `move` question. With the guard on, moves that die on this step are not
 * offered; with hints on, each option states what it leads to.
 */
export function moveQuestion(game: Game, options: { guard: boolean; hints: boolean }) {
  const criteria: Record<string, string | null> = {};
  for (const dir of DIRECTIONS) {
    const check = checkMove(game, dir);
    if (check.fatal === "reverse") continue;
    if (options.guard && check.fatal) continue;
    if (!options.hints) {
      criteria[dir] = null;
      continue;
    }
    if (check.fatal === "wall") criteria[dir] = `hits the wall at (${check.to.x},${check.to.y}) and dies`;
    else if (check.fatal === "body") criteria[dir] = `bites its own body at (${check.to.x},${check.to.y}) and dies`;
    else {
      const parts = [`head goes to (${check.to.x},${check.to.y})`];
      if (check.eats) parts.push("eats the food");
      else if (game.food) parts.push(`food distance becomes ${distance(check.to, game.food)} (now ${distance(game.snake[0], game.food)})`);
      const room = reachableAfter(game, dir);
      parts.push(room < game.snake.length ? `only ${room} free cells reachable afterwards: a trap` : `${room} free cells reachable afterwards`);
      criteria[dir] = parts.join("; ");
    }
  }
  return {
    type: "choice" as const,
    instructions:
      "You steer the snake. Pick the next move: reach the food as fast as possible, never hit a wall or the snake's own body, and avoid moves that leave too little free space.",
    criteria,
  };
}

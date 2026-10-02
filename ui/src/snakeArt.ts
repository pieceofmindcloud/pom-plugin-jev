/**
 * Drawing for the Snake demo: a grass field, a tapered scaled snake that
 * slides between cells, a glossy apple and small particle bursts. Pure canvas,
 * no assets; the game rules live in `snake.ts`.
 */
import { DIRS, GRID, type Cell, type Direction, type Game } from "./snake";

export type Particle = { x: number; y: number; vx: number; vy: number; life: number; hue: number };

export type Scene = {
  game: Game;
  /** Snake before the last move, for the slide animation. */
  previous: Cell[] | null;
  /** 0..1 progress of the slide from `previous` to `game.snake`. */
  progress: number;
  now: number;
  hint: Direction | null;
  particles: Particle[];
  /** ms since the game ended, or null while alive. */
  deadFor: number | null;
};

type Point = { x: number; y: number };

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ease = (t: number) => 1 - (1 - t) * (1 - t);

let grass: { size: number; canvas: HTMLCanvasElement } | null = null;

/** The field is painted once per size into an offscreen canvas. */
function grassField(size: number): HTMLCanvasElement {
  if (grass && grass.size === size) return grass.canvas;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const s = size / GRID;
  const base = ctx.createLinearGradient(0, 0, size, size);
  base.addColorStop(0, "#2e5a32");
  base.addColorStop(0.5, "#264c2a");
  base.addColorStop(1, "#1c3b21");
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  // Mowed stripes, like a sports field.
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      if ((x + y) % 2 === 0) {
        ctx.fillStyle = "rgba(255,255,255,.035)";
        ctx.fillRect(x * s, y * s, s, s);
      }
    }
  }
  // Blades and specks with a fixed seed, so the field never flickers.
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const blades = Math.round((size * size) / 90);
  for (let i = 0; i < blades; i++) {
    const x = random() * size;
    const y = random() * size;
    const length = 2 + random() * s * 0.22;
    const lean = (random() - 0.5) * 1.6;
    ctx.strokeStyle = random() > 0.5 ? "rgba(120,190,110,.10)" : "rgba(10,30,14,.22)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + lean, y - length);
    ctx.stroke();
  }
  for (let i = 0; i < blades / 6; i++) {
    ctx.fillStyle = `rgba(${random() > 0.5 ? "230,220,150" : "160,220,140"},${0.05 + random() * 0.07})`;
    ctx.beginPath();
    ctx.arc(random() * size, random() * size, 0.6 + random() * 1.2, 0, Math.PI * 2);
    ctx.fill();
  }
  const vignette = ctx.createRadialGradient(size / 2, size / 2, size * 0.25, size / 2, size / 2, size * 0.75);
  vignette.addColorStop(0, "rgba(0,0,0,0)");
  vignette.addColorStop(1, "rgba(0,0,0,.42)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, size, size);
  grass = { size, canvas };
  return canvas;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawApple(ctx: CanvasRenderingContext2D, cell: Cell, s: number, now: number) {
  const bob = Math.sin(now / 420) * s * 0.04;
  const cx = (cell.x + 0.5) * s;
  const cy = (cell.y + 0.52) * s + bob;
  const r = s * 0.34;
  // Contact shadow on the grass.
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,.35)";
  ctx.beginPath();
  ctx.ellipse(cx + s * 0.05, (cell.y + 0.86) * s, r * 0.95 - bob * 0.5, r * 0.32, 0, 0, Math.PI * 2);
  ctx.fill();
  // Soft glow so the target reads at a glance.
  const glow = ctx.createRadialGradient(cx, cy, r * 0.4, cx, cy, r * 2.4);
  glow.addColorStop(0, "rgba(255,90,70,.22)");
  glow.addColorStop(1, "rgba(255,90,70,0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 2.4, 0, Math.PI * 2);
  ctx.fill();
  // Body: two lobes.
  const body = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.1, cx, cy, r * 1.15);
  body.addColorStop(0, "#ff8a7a");
  body.addColorStop(0.35, "#e5332a");
  body.addColorStop(0.85, "#a5161a");
  body.addColorStop(1, "#6f0d12");
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.moveTo(cx, cy - r * 0.62);
  ctx.bezierCurveTo(cx + r * 0.5, cy - r * 1.05, cx + r * 1.15, cy - r * 0.55, cx + r * 0.98, cy + r * 0.18);
  ctx.bezierCurveTo(cx + r * 0.85, cy + r * 0.85, cx + r * 0.35, cy + r * 1.05, cx, cy + r * 0.88);
  ctx.bezierCurveTo(cx - r * 0.35, cy + r * 1.05, cx - r * 0.85, cy + r * 0.85, cx - r * 0.98, cy + r * 0.18);
  ctx.bezierCurveTo(cx - r * 1.15, cy - r * 0.55, cx - r * 0.5, cy - r * 1.05, cx, cy - r * 0.62);
  ctx.fill();
  // Stem and leaf.
  ctx.strokeStyle = "#5a3a1c";
  ctx.lineWidth = Math.max(1.5, s * 0.06);
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(cx, cy - r * 0.6);
  ctx.quadraticCurveTo(cx + r * 0.05, cy - r * 1.0, cx + r * 0.2, cy - r * 1.2);
  ctx.stroke();
  const leaf = ctx.createLinearGradient(cx, cy - r * 1.3, cx + r * 0.9, cy - r * 0.8);
  leaf.addColorStop(0, "#9be36b");
  leaf.addColorStop(1, "#3f8f2f");
  ctx.fillStyle = leaf;
  ctx.beginPath();
  ctx.moveTo(cx + r * 0.12, cy - r * 0.95);
  ctx.quadraticCurveTo(cx + r * 0.55, cy - r * 1.45, cx + r * 0.95, cy - r * 1.0);
  ctx.quadraticCurveTo(cx + r * 0.5, cy - r * 0.72, cx + r * 0.12, cy - r * 0.95);
  ctx.fill();
  // Specular highlight.
  const shine = ctx.createRadialGradient(cx - r * 0.42, cy - r * 0.35, 0, cx - r * 0.42, cy - r * 0.35, r * 0.45);
  shine.addColorStop(0, "rgba(255,255,255,.75)");
  shine.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = shine;
  ctx.beginPath();
  ctx.ellipse(cx - r * 0.42, cy - r * 0.35, r * 0.32, r * 0.22, -0.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Centre of every segment, slid from where it was by `progress`. */
function bodyPoints(scene: Scene, s: number): Point[] {
  const { game, previous } = scene;
  const t = ease(Math.min(Math.max(scene.progress, 0), 1));
  return game.snake.map((cell, index) => {
    const from = previous?.[index] ?? previous?.[previous.length - 1] ?? cell;
    // A grown tail stays put; a teleport (new game) never slides.
    const jump = Math.abs(from.x - cell.x) + Math.abs(from.y - cell.y) > 1;
    const k = jump ? 1 : t;
    return { x: (lerp(from.x, cell.x, k) + 0.5) * s, y: (lerp(from.y, cell.y, k) + 0.5) * s };
  });
}

/** Rounds the grid corners (Chaikin), keeping both ends in place. */
function smooth(points: Point[], rounds = 2): Point[] {
  let current = points;
  for (let round = 0; round < rounds && current.length > 2; round++) {
    const next: Point[] = [current[0]];
    for (let i = 0; i < current.length - 1; i++) {
      const a = current[i];
      const b = current[i + 1];
      next.push({ x: lerp(a.x, b.x, 0.25), y: lerp(a.y, b.y, 0.25) });
      next.push({ x: lerp(a.x, b.x, 0.75), y: lerp(a.y, b.y, 0.75) });
    }
    next.push(current[current.length - 1]);
    current = next;
  }
  return current;
}

/** A dense centre line through the points, for a smooth tapered body. */
function sample(raw: Point[]): Point[] {
  const points = smooth(raw);
  if (points.length < 2) return points.slice();
  const out: Point[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const steps = 2;
    for (let k = 0; k < steps; k++) out.push({ x: lerp(a.x, b.x, k / steps), y: lerp(a.y, b.y, k / steps) });
  }
  out.push(points[points.length - 1]);
  return out;
}

function drawSnake(ctx: CanvasRenderingContext2D, scene: Scene, s: number) {
  const points = bodyPoints(scene, s);
  if (!points.length) return;
  const line = sample(points);
  const n = line.length;
  const dead = scene.deadFor !== null;
  const palette = dead
    ? { dark: "#3b3f3a", mid: "#6b716a", light: "#a7ada5", spot: "#2a2d29", belly: "#c9cfc6" }
    : { dark: "#1f4d22", mid: "#3f8f3a", light: "#8fd47a", spot: "#173b19", belly: "#d9e8a8" };
  // Thick neck, slow taper, thin tail tip.
  const width = (i: number) => {
    const t = i / Math.max(n - 1, 1);
    return s * (t < 0.7 ? lerp(0.94, 0.8, t / 0.7) : lerp(0.8, 0.32, (t - 0.7) / 0.3));
  };

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  // Ground shadow.
  for (let i = n - 1; i > 0; i--) {
    ctx.strokeStyle = "rgba(0,0,0,.28)";
    ctx.lineWidth = width(i) * 1.02;
    ctx.beginPath();
    ctx.moveTo(line[i].x + s * 0.1, line[i].y + s * 0.14);
    ctx.lineTo(line[i - 1].x + s * 0.1, line[i - 1].y + s * 0.14);
    ctx.stroke();
  }
  // Body: dark outline, mid tone, then the lit back.
  for (const [color, scale] of [
    [palette.dark, 1],
    [palette.mid, 0.82],
  ] as const) {
    for (let i = n - 1; i > 0; i--) {
      ctx.strokeStyle = color;
      ctx.lineWidth = width(i) * scale;
      ctx.beginPath();
      ctx.moveTo(line[i].x, line[i].y);
      ctx.lineTo(line[i - 1].x, line[i - 1].y);
      ctx.stroke();
    }
  }
  // Scales: a chain of dark saddles along the back, alternating sides.
  const every = Math.max(2, Math.round(n / Math.max(points.length * 2, 1)));
  for (let i = every; i < n - 1; i += every) {
    const a = line[i - 1];
    const b = line[i + 1];
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const w = width(i);
    ctx.save();
    ctx.translate(line[i].x, line[i].y);
    ctx.rotate(angle);
    // Python-like saddle: a dark diamond with a lighter core, and small
    // flank spots alternating sides.
    const d = w * 0.34;
    ctx.globalAlpha = 0.7;
    ctx.fillStyle = palette.spot;
    ctx.beginPath();
    ctx.moveTo(-d, 0);
    ctx.lineTo(0, -d * 0.85);
    ctx.lineTo(d, 0);
    ctx.lineTo(0, d * 0.85);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 0.45;
    ctx.fillStyle = palette.light;
    ctx.beginPath();
    ctx.moveTo(-d * 0.45, 0);
    ctx.lineTo(0, -d * 0.35);
    ctx.lineTo(d * 0.45, 0);
    ctx.lineTo(0, d * 0.35);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = palette.spot;
    ctx.beginPath();
    ctx.ellipse(d * 1.3, (i % 2 ? 1 : -1) * w * 0.3, w * 0.07, w * 0.05, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.restore();
  }
  // Highlight along the back.
  ctx.globalAlpha = 0.35;
  for (let i = n - 1; i > 0; i--) {
    ctx.strokeStyle = palette.light;
    ctx.lineWidth = width(i) * 0.22;
    ctx.beginPath();
    ctx.moveTo(line[i].x - s * 0.06, line[i].y - s * 0.08);
    ctx.lineTo(line[i - 1].x - s * 0.06, line[i - 1].y - s * 0.08);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.restore();

  drawHead(ctx, scene, points, s, palette);
}

function drawHead(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  points: Point[],
  s: number,
  palette: { dark: string; mid: string; light: string; spot: string; belly: string },
) {
  const head = points[0];
  const neck = points[1] ?? { x: head.x - DIRS[scene.game.dir].x * s, y: head.y - DIRS[scene.game.dir].y * s };
  const angle = Math.atan2(head.y - neck.y, head.x - neck.x);
  const L = s * 0.84;
  const W = s * 0.66;
  ctx.save();
  ctx.translate(head.x, head.y);
  ctx.rotate(angle);
  // Tongue: flicks every couple of seconds while alive.
  const flick = (scene.now % 2200) / 2200;
  if (scene.deadFor === null && flick < 0.16) {
    const out = Math.sin((flick / 0.16) * Math.PI) * s * 0.42;
    ctx.strokeStyle = "#d83a4a";
    ctx.lineWidth = Math.max(1.2, s * 0.045);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(L * 0.5, 0);
    ctx.lineTo(L * 0.5 + out, 0);
    ctx.lineTo(L * 0.5 + out + s * 0.1, -s * 0.07);
    ctx.moveTo(L * 0.5 + out, 0);
    ctx.lineTo(L * 0.5 + out + s * 0.1, s * 0.07);
    ctx.stroke();
  }
  ctx.fillStyle = "rgba(0,0,0,.28)";
  ctx.beginPath();
  ctx.ellipse(s * 0.08, s * 0.12, L * 0.6, W * 0.62, 0, 0, Math.PI * 2);
  ctx.fill();
  const skull = ctx.createRadialGradient(-L * 0.1, -W * 0.35, W * 0.1, 0, 0, L * 0.75);
  skull.addColorStop(0, palette.light);
  skull.addColorStop(0.55, palette.mid);
  skull.addColorStop(1, palette.dark);
  ctx.fillStyle = skull;
  ctx.beginPath();
  ctx.moveTo(-L * 0.45, -W * 0.5);
  ctx.bezierCurveTo(L * 0.1, -W * 0.72, L * 0.6, -W * 0.45, L * 0.62, 0);
  ctx.bezierCurveTo(L * 0.6, W * 0.45, L * 0.1, W * 0.72, -L * 0.45, W * 0.5);
  ctx.quadraticCurveTo(-L * 0.62, 0, -L * 0.45, -W * 0.5);
  ctx.fill();
  // Head plate markings.
  ctx.fillStyle = palette.spot;
  ctx.globalAlpha = 0.45;
  ctx.beginPath();
  ctx.ellipse(-L * 0.12, 0, L * 0.2, W * 0.14, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
  // Eyes with slit pupils; closed when dead.
  for (const side of [-1, 1]) {
    const ex = L * 0.18;
    const ey = side * W * 0.36;
    ctx.fillStyle = "#e9d84a";
    ctx.beginPath();
    ctx.ellipse(ex, ey, s * 0.1, s * 0.085, 0, 0, Math.PI * 2);
    ctx.fill();
    if (scene.deadFor !== null) {
      ctx.strokeStyle = "#1a1a1a";
      ctx.lineWidth = Math.max(1, s * 0.03);
      ctx.beginPath();
      ctx.moveTo(ex - s * 0.07, ey - s * 0.06);
      ctx.lineTo(ex + s * 0.07, ey + s * 0.06);
      ctx.moveTo(ex - s * 0.07, ey + s * 0.06);
      ctx.lineTo(ex + s * 0.07, ey - s * 0.06);
      ctx.stroke();
    } else {
      ctx.fillStyle = "#0d0d0d";
      ctx.beginPath();
      ctx.ellipse(ex + s * 0.015, ey, s * 0.022, s * 0.075, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,.8)";
      ctx.beginPath();
      ctx.arc(ex - s * 0.03, ey - s * 0.03, s * 0.018, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // Nostrils.
  ctx.fillStyle = "rgba(10,25,10,.7)";
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(L * 0.5, side * W * 0.12, s * 0.02, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawHint(ctx: CanvasRenderingContext2D, scene: Scene, s: number) {
  if (!scene.hint || !scene.game.snake.length) return;
  const head = scene.game.snake[0];
  const to = { x: head.x + DIRS[scene.hint].x, y: head.y + DIRS[scene.hint].y };
  const pulse = 0.5 + 0.5 * Math.sin(scene.now / 160);
  ctx.save();
  ctx.strokeStyle = `rgba(190,255,170,${0.35 + 0.3 * pulse})`;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 4]);
  roundRect(ctx, to.x * s + 3, to.y * s + 3, s - 6, s - 6, s * 0.25);
  ctx.stroke();
  ctx.restore();
}

/** Starts a burst where the snake just ate. */
export function burst(cell: Cell, particles: Particle[]) {
  for (let i = 0; i < 18; i++) {
    const angle = (Math.PI * 2 * i) / 18 + Math.random() * 0.4;
    const speed = 0.02 + Math.random() * 0.045;
    particles.push({
      x: cell.x + 0.5,
      y: cell.y + 0.5,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 1,
      hue: Math.random() > 0.5 ? 6 : 48,
    });
  }
}

function drawParticles(ctx: CanvasRenderingContext2D, particles: Particle[], s: number) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx;
    p.y += p.vy;
    p.vx *= 0.94;
    p.vy *= 0.94;
    p.life -= 0.03;
    if (p.life <= 0) {
      particles.splice(i, 1);
      continue;
    }
    ctx.fillStyle = `hsla(${p.hue}, 95%, 62%, ${p.life})`;
    ctx.beginPath();
    ctx.arc(p.x * s, p.y * s, s * 0.07 * p.life + 0.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

export function drawScene(ctx: CanvasRenderingContext2D, size: number, dpr: number, scene: Scene) {
  const s = size / GRID;
  ctx.clearRect(0, 0, size, size);
  ctx.save();
  roundRect(ctx, 0, 0, size, size, s * 0.6);
  ctx.clip();
  ctx.drawImage(grassField(Math.round(size * dpr)), 0, 0, size, size);
  drawHint(ctx, scene, s);
  if (scene.game.food) drawApple(ctx, scene.game.food, s, scene.now);
  drawSnake(ctx, scene, s);
  drawParticles(ctx, scene.particles, s);
  if (scene.deadFor !== null && scene.deadFor < 600) {
    ctx.fillStyle = `rgba(220,40,40,${0.28 * (1 - scene.deadFor / 600)})`;
    ctx.fillRect(0, 0, size, size);
  }
  ctx.restore();
  // Inner rim.
  ctx.strokeStyle = "rgba(255,255,255,.08)";
  ctx.lineWidth = 1;
  roundRect(ctx, 0.5, 0.5, size - 1, size - 1, s * 0.6);
  ctx.stroke();
}

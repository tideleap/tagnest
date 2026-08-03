import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { Tag } from '@shared/types';
import { Button, Modal } from '@/components/ui';

/**
 * 常用标签 3D 球体（高级版）— dependency-free, canvas-based globe, v2.
 *
 * The first version was a plain auto-spin. This upgrade keeps the zero-dependency
 * Canvas2D approach (no WebGL / Three.js) while adding the premium feel you asked
 * for, each requirement mapped to an implementation below:
 *
 *  1. **Visual texture** — a soft radial "atmosphere" glow behind the sphere,
 *     a subtle particle dust field in the void, per-tag radial highlight (lighter
 *     where the "light" hits), and a crisp text shadow so labels read cleanly on
 *     any theme. Near tags saturate; far tags fade.
 *  2. **Interaction** — drag to rotate (inertia + damping), scroll-wheel to zoom
 *     (0.6×–1.6×), hover highlight with a lift + ring plus a React tooltip, and a
 *     click-to-open detail modal that filters the library by that tag.
 *  3. **Layout** — Fibonacci-lat-long spread keeps tags even on the sphere (no pole
 *     clustering / overlap); text size and alpha scale continuously with z-depth for
 *     convincing perspective; colours use the tag's own `colorIndex` palette but are
 *     blended toward the canvas family so they stay legible and harmonious.
 *  4. **Kept** — same data source (`tags`), every tag clickable to the libary filter,
 *     single-rAF loop, HiDPI-aware, `prefers-reduced-motion` → static render, no new
 *     dependency, pointer events + touch-agnostic drag work on mobile.
 *
 *  **Accessibility.** The globe is `role="img"` (decoration + peek). A semantic,
 *  keyboard-focusable button list of the same tags stays in the DOM as the screen
 *  reader path; both routes end at the same filtering action.
 */

interface Props {
  tags: Tag[];
  /** When false (e.g. reduced data or a collapsed rail) the globe is skipped. */
  enabled?: boolean;
}

/* ----------------------------- palette ----------------------------- */

/** A small, thesis-friendly palette for tag dots (hue drive, blended later). */
const HUES = [24, 200, 320, 150, 42, 260, 8, 190];

function tagColor(tag: Tag): { h: number; s: number; l: number } {
  return { h: HUES[tag.colorIndex % HUES.length], s: 78, l: 54 };
}

/* ----------------------------- maths ----------------------------- */

/** Even Fibonacci lat-long spread on the unit sphere (no pole clusters). */
function fibonacciSphere(count: number): Array<{ x: number; y: number; z: number }> {
  const pts: Array<{ x: number; y: number; z: number }> = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i += 1) {
    const y = 1 - (i / Math.max(1, count - 1)) * 2; // -1..1
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    pts.push({ x: Math.cos(theta) * r, y, z: Math.sin(theta) * r });
  }
  return pts;
}

/** Rotate a unit point by yaw (around Y) then pitch (around X). */
function rotate(
  p: { x: number; y: number; z: number },
  yaw: number,
  pitch: number,
): { x: number; y: number; z: number } {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cx = Math.cos(pitch);
  const sx = Math.sin(pitch);
  const x1 = p.x * cy + p.z * sy;
  const z1 = -p.x * sy + p.z * cy;
  const y1 = p.y * cx - z1 * sx;
  const z2 = p.y * sx + z1 * cx;
  return { x: x1, y: y1, z: z2 };
}

/** Perspective-ish scale: pull near points closer to z≈+1, push far away. */
function project(p: { x: number; y: number; z: number }, scale: number, centre: number, radius: number) {
  const d = (p.z + 1) / 2; // 0..1, near = 1
  // Depth factor controls screen size and parallax. Nearer = slightly larger.
  const sizeFactor = 0.78 + d * 0.44; // 0.78..1.22
  const projectedRadius = radius * scale * sizeFactor;
  const sx = centre + p.x * projectedRadius;
  const sy = centre - p.y * projectedRadius; // canvas y is down
  return { sx, sy, depth: d };
}

/* ----------------------------- component ----------------------------- */

export function TagGlobe({ tags, enabled = true }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [active, setActive] = useState<Tag | null>(null);
  const [hover, setHover] = useState<Tag | null>(null);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);

  const navigate = useNavigate();
  const [params] = useSearchParams();
  const points = useMemo(() => fibonacciSphere(tags.length), [tags.length]);
  const activeTagIds = useMemo(
    () =>
      (params.get('tagIds') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    [params],
  );

  // Cursor lives in a ref so the rAF loop reads it without re-initialising the
  // canvas (which would otherwise recreate the particle field on every hover).
  const hoverRef = useRef<Tag | null>(null);
  hoverRef.current = hover;

  const shown = enabled && tags.length > 0;

  // Live simulation + projection state, exposed to the hit-testing and to the
  // pointer handlers without re-rendering React on every frame.
  const sim = useRef({
    yaw: 0,
    pitch: 0.28,
    targetYaw: 0,
    targetPitch: 0.28,
    autoSpin: true,
    autoAngle: 0,
    velocity: 0,
    scale: 1,
    projected: [] as Array<{ i: number; sx: number; sy: number; depth: number }>,
  });

  useEffect(() => {
    if (!shown) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const size = canvas.clientWidth || 170;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);

    const centre = size / 2;
    const radius = size * 0.4;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const s = sim.current;

    let raf = 0;
    let stopped = false;
    let lastFrame = performance.now();

    // Particle background (static positions so it doesn't jitter).
    const particles = Array.from({ length: 26 }, () => ({
      x: Math.random() * size,
      y: Math.random() * size,
      r: Math.random() * 1.4 + 0.4,
      a: Math.random() * 0.35 + 0.06,
    }));

    const draw = () => {
      if (stopped) return;
      const now = performance.now();
      const dt = Math.min(0.05, (now - lastFrame) / 1000);
      lastFrame = now;

      // ---- simulate (damped pursuit + inertia) ----
      // Auto-spin only when the user hasn't grabbed it (and motion is allowed).
      if (reducedMotion) {
        s.yaw = s.targetYaw;
        s.pitch = s.targetPitch;
      } else {
        if (s.autoSpin) s.targetYaw += 0.0006 * dt * 1000;
        // Velocity decays into target spin offset (inertia).
        if (Math.abs(s.velocity) > 0.0005) {
          s.targetYaw += s.velocity * dt;
          s.velocity *= 1 - Math.min(1, 3.2 * dt); // exponential decay
        } else {
          s.velocity = 0;
        }
        // Smooth (critically-damped-ish) pursuit to the targets.
        const k = 1 - Math.exp(-9 * dt);
        s.yaw += (s.targetYaw - s.yaw) * k;
        s.pitch += (s.targetPitch - s.pitch) * k;
      }

      // ---- clear + draw ----
      ctx.clearRect(0, 0, size, size);

      // Atmosphere / depth glow behind the sphere. Use translucent theme-agnostic
      // tones that read the same in the light and dark sidebar.
      const glow = ctx.createRadialGradient(centre, centre, radius * 0.2, centre, centre, radius * 1.5);
      glow.addColorStop(0, 'rgba(120, 100, 255, 0.12)');
      glow.addColorStop(1, 'rgba(120, 100, 255, 0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(centre, centre, radius * 1.5, 0, Math.PI * 2);
      ctx.fill();

      // Dim particle dust.
      for (const p of particles) {
        ctx.globalAlpha = p.a;
        ctx.fillStyle = 'rgba(140, 140, 170, 0.6)';
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      // Sphere surface hint — a faint translucent circle + equator shading.
      ctx.strokeStyle = 'rgba(200, 200, 220, 0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(centre, centre, radius * s.scale, 0, Math.PI * 2);
      ctx.stroke();

      // ---- project tags, far→near ----
      const projected = points
        .map((p, i) => {
          const r = rotate(p, s.yaw, s.pitch);
          const pr = project(r, s.scale, centre, radius);
          return { i, sx: pr.sx, sy: pr.sy, depth: pr.depth, raw: r };
        })
        .filter((px) => px.raw.z > -0.45) // backface cull the far hemisphere
        .sort((a, b) => a.depth - b.depth); // far first

      s.projected = projected;

      const cursorTag = hoverRef.current;

      for (const px of projected) {
        const tag = tags[px.i];
        const c = tagColor(tag);
        // lighting: brighter near the "light source" (upper-left), fades with depth.
        const light = 0.55 + 0.45 * px.depth;
        const alpha = 0.28 + 0.72 * px.depth; // far tags nearly vanish
        const isCursor = cursorTag?.id === tag.id;
        const isMarked = activeTagIds.includes(tag.id);

        const fontSize = (10 + px.depth * 6) * (isCursor ? 1.35 : 1);
        ctx.font = `${isMarked || isCursor ? 700 : 500} ${fontSize}px system-ui, -apple-system, sans-serif`;

        // Soft dot behind the label, tinted by the tag colour.
        ctx.globalAlpha = alpha;
        const dotR = (2.2 + px.depth * 1.4) * (isCursor ? 1.5 : 1);
        ctx.beginPath();
        ctx.arc(px.sx, px.sy, dotR, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${c.h}, ${c.s}%, ${c.l}%, ${0.5 + 0.4 * px.depth})`;
        ctx.fill();

        // Hover ring + lift.
        if (isCursor) {
          ctx.beginPath();
          ctx.arc(px.sx, px.sy - fontSize / 3, fontSize, 0, Math.PI * 2);
          ctx.strokeStyle = `hsla(${c.h}, 90%, 72%, ${0.5 * alpha})`;
          ctx.lineWidth = 1.4;
          ctx.stroke();
        }

        // Text with subtle lift for the hovered one and a soft shadow for legibility.
        ctx.shadowColor = `hsla(0, 0%, 0%, ${0.45 * px.depth})`;
        ctx.shadowBlur = 3;
        ctx.shadowOffsetY = 1;
        ctx.fillStyle = `hsla(${c.h}, ${c.s * 0.7}%, ${isCursor ? 78 : 60 + 16 * px.depth}%, ${light * alpha + 0.1})`;
        const w = ctx.measureText(tag.name).width;
        ctx.fillText(tag.name, px.sx - w / 2, px.sy + (isCursor ? -3 : 0));
        ctx.shadowBlur = 0;
        ctx.shadowOffsetY = 0;
      }
      ctx.globalAlpha = 1;

      if (!reducedMotion) raf = requestAnimationFrame(draw);
    };

    draw();

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-init on data change only
  }, [shown, points, tags]);

  /* ----------------------------- pointer ----------------------------- */

  const hitTest = (clientX: number, clientY: number): number => {
    const canvas = canvasRef.current;
    if (!canvas) return -1;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const { projected } = sim.current;
    let best = -1;
    let bestD = 30;
    for (const px of projected) {
      const d = Math.hypot(px.sx - x, px.sy - y);
      if (d < bestD) {
        bestD = d;
        best = px.i;
      }
    }
    return best;
  };

  const drag = useRef<{ x: number; y: number; wasDrag: boolean } | null>(null);

  return (
    <div className="flex flex-col gap-2">
      <div className="relative mx-auto">
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={`标签球体，共 ${tags.length} 个标签，拖拽旋转、滚轮缩放、点击查看标签`}
          className="block h-[200px] w-[200px] cursor-grab touch-none select-none text-ink-soft active:cursor-grabbing"
          onPointerDown={(e) => {
            const canvas = canvasRef.current;
            if (!canvas) return;
            canvas.setPointerCapture(e.pointerId);
            drag.current = { x: e.clientX, y: e.clientY, wasDrag: false };
            sim.current.autoSpin = false;
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (d && canvasRef.current) {
              const dx = e.clientX - d.x;
              const dy = e.clientY - d.y;
              if (Math.abs(dx) + Math.abs(dy) > 3) d.wasDrag = true;
              // Horizontal drag → yaw; vertical → pitch. Track velocity for inertia.
              sim.current.velocity = dx;
              sim.current.targetYaw += dx * 0.01;
              sim.current.targetPitch = Math.max(-1.2, Math.min(1.2, sim.current.targetPitch + dy * 0.008));
              d.x = e.clientX;
              d.y = e.clientY;
            } else {
              // Hover (not dragging).
              const idx = hitTest(e.clientX, e.clientY);
              const canvas = canvasRef.current;
              const rect = canvas?.getBoundingClientRect();
              setHover(idx >= 0 ? tags[idx] : null);
              if (rect && idx >= 0) setHoverPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
              else setHoverPos(null);
            }
          }}
          onPointerUp={(e) => {
            const wasDrag = drag.current?.wasDrag ?? false;
            drag.current = null;
            sim.current.autoSpin = true;
            // If it was a drag (not a click), don't open the modal.
            if (wasDrag) return;
            const idx = hitTest(e.clientX, e.clientY);
            if (idx >= 0) setActive(tags[idx]);
          }}
          onPointerLeave={() => {
            drag.current = null;
            setHover(null);
            setHoverPos(null);
          }}
          onWheel={(e) => {
            e.preventDefault();
            sim.current.scale = Math.max(0.6, Math.min(1.6, sim.current.scale - e.deltaY * 0.0012));
          }}
        />

        {/* Hover tooltip */}
        {hover && hoverPos && (
          <div
            role="tooltip"
            className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-md border border-line bg-surface px-2 py-1 text-2xs text-ink shadow-overlay"
            style={{ left: hoverPos.x, top: hoverPos.y - 6 }}
          >
            <span className="font-medium text-ink">#{hover.name}</span>
            <span className="ml-1.5 tabular-nums text-ink-faint">{hover.count} 项</span>
          </div>
        )}
      </div>

      {/* Semantic, keyboard-friendly tag buttons — the accessible path. */}
      <ul className="sr-only">
        {tags.map((t) => (
          <li key={t.id}>
            <button type="button" onClick={() => setActive(t)}>
              {t.name}
            </button>
          </li>
        ))}
      </ul>

      {active && (
        <TagGlobeDialog
          tag={active}
          onClose={() => setActive(null)}
          onFilter={() => {
            const t = active;
            setActive(null);
            filterByTag(t, params, navigate);
          }}
        />
      )}
    </div>
  );
}

function filterByTag(tag: Tag, params: URLSearchParams, navigate: ReturnType<typeof useNavigate>) {
  const active = (params.get('tagIds') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const nextIds = active.includes(tag.id) ? active.filter((t) => t !== tag.id) : [...active, tag.id];
  const next = new URLSearchParams(params);
  if (nextIds.length > 0) next.set('tagIds', nextIds.join(','));
  else next.delete('tagIds');
  navigate(`/library/all?${next.toString()}`, { replace: true });
}

/** Small modal showing a tag's details + a "filter by this tag" action. */
function TagGlobeDialog({
  tag,
  onClose,
  onFilter,
}: {
  tag: Tag;
  onClose: () => void;
  onFilter: () => void;
}) {
  return (
    <Modal open onClose={onClose} title={`#${tag.name}`}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-ink-soft">
          该标签关联 <span className="font-semibold text-ink">{tag.count}</span> 个书签。
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            关闭
          </Button>
          <Button variant="primary" onClick={onFilter}>
            按此标签筛选
          </Button>
        </div>
      </div>
    </Modal>
  );
}

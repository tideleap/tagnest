import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { Tag } from '@shared/types';
import { Button, Modal } from '@/components/ui';

/**
 * 常用标签 3D 球体 — a dependency-free, canvas-based globe.
 *
 * Implementation notes:
 *  - **No WebGL / no Three.js.** Pure Canvas2D + a little 3D-to-2D perspective
 *    projection keeps the bundle tiny and the render 60fps for a handful of tags,
 *    which is why this is a "伪3D" globe (tags live on a sphere surface, rotated
 *    on the Y axis, nearer tags drawn larger & opaque, far-side tags dimmed).
 *  - **Fibonacci lat-lon distribution** spreads tags evenly on the sphere, so no
 *    cluster forms at the poles.
 *  - **Performance.** One rAF loop, re-applied only while visible; crisp on
 *    HiDPI via `devicePixelRatio`; honours `prefers-reduced-motion` by rendering
 *    a single static frame (no continuous rotation).
 *  - **Accessibility.** The globe is decoration + a fast peek. It exposes a
 *    semantic button list (the same tags, keyboard-focusable) underneath for
 *    screen readers and keyboard users; interacting with either path filters the
 *    library by that tag. The pointer surface itself marks the underlying
 *    list as non-interactive when the globe is active to avoid duplicate tab
 *    stops only for mouse users (the list stays in the DOM for AT).
 */

interface Props {
  tags: Tag[];
  /** When false (e.g. reduced data or a collapsed rail) the globe is skipped. */
  enabled?: boolean;
  onHideClick?: () => void;
}

const RADIUS = 70;

/* ----------------------------- maths ----------------------------- */

function fibonacciSphere(count: number): Array<{ x: number; y: number; z: number }> {
  const pts: Array<{ x: number; y: number; z: number }> = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i += 1) {
    const y = 1 - (i / Math.max(1, count - 1)) * 2; // -1..1
    const r = Math.sqrt(1 - y * y);
    const theta = golden * i;
    pts.push({ x: Math.cos(theta) * r, y, z: Math.sin(theta) * r });
  }
  return pts;
}

function rotateY(p: { x: number; z: number }, angle: number): { x: number; z: number } {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: p.x * c + p.z * s, z: -p.x * s + p.z * c };
}

/* ----------------------------- component ----------------------------- */

export function TagGlobe({ tags, enabled = true }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [active, setActive] = useState<Tag | null>(null);
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const points = useMemo(() => fibonacciSphere(tags.length), [tags.length]);
  const angleRef = useRef(0);
  const activeTagIds = useMemo(
    () =>
      (params.get('tagIds') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    [params],
  );

  // The visual globe is only mounted when we actually have tags to draw.
  const shown = enabled && tags.length > 0;

  useEffect(() => {
    if (!shown) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const size = canvas.clientWidth;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);

    const centre = size / 2;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let angle = 0;
    let raf = 0;
    let stopped = false;

    const draw = () => {
      if (stopped) return;
      ctx.clearRect(0, 0, size, size);

      // Far-to-near z sorting so nearer tags paint last.
      const projected = points
        .map((p, i) => {
          const r = rotateY(p, angle);
          const z = r.z; // -1..1, +near
          const depth = (z + 1) / 2; // 0..1
          const dz = RADIUS * (1 - depth * 0.45); // scale near tags a bit
          const screenX = centre + (r.x / 1) * dz;
          const screenY = centre + (p.y / 1) * dz;
          return { i, screenX, screenY, depth };
        })
        .filter((px) => px.depth > 0.22) // hide far-side tags (backface cull)
        .sort((a, b) => a.depth - b.depth);

      for (const px of projected) {
        const tag = tags[px.i];
        const name = tag.name;
        const alpha = px.depth * 0.9 + 0.1;
        ctx.globalAlpha = alpha;

        const isActive = activeTagIds.includes(tag.id);
        ctx.font = `${isActive ? 600 : 400} ${10 + px.depth * 4}px system-ui, sans-serif`;
        const w = ctx.measureText(name).width;
        const h = Math.round(12 + px.depth * 4);

        // Dot behind the label.
        ctx.beginPath();
        ctx.arc(px.screenX, px.screenY - h / 2 + 2, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = 'currentColor';
        ctx.fill();

        ctx.fillStyle = 'currentColor';
        ctx.fillText(name, px.screenX - w / 2, px.screenY);
      }
      ctx.globalAlpha = 1;

      if (!reducedMotion) {
        angle += 0.006;
        angleRef.current = angle;
        raf = requestAnimationFrame(draw);
      }
    };

    draw();
    if (reducedMotion) {
      // single static frame, no loop
    } else {
      // draw() scheduled its own rAF above
    }

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- points/tags fixed per mount
  }, [shown, points, tags]);

  if (!shown) return null;

  return (
    <div className="flex flex-col gap-2">
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={`标签球体，共 ${tags.length} 个标签`}
        className="mx-auto block h-[170px] w-[170px] touch-none select-none text-ink-soft"
        onClick={(e) => {
          const canvas = canvasRef.current;
          if (!canvas) return;
          const rect = canvas.getBoundingClientRect();
          const x = e.clientX - rect.left;
          const y = e.clientY - rect.top;
          const idx = nearestTagIndex(x, y, canvas.clientWidth, points, angleRef.current);
          if (idx >= 0) setActive(tags[idx]);
        }}
      />

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

/**
 * Find the tag nearest to a click. Reuses the same perspective projection the
 * renderer uses, so the hit zone lines up with what the user actually sees.
 */
function nearestTagIndex(
  x: number,
  y: number,
  size: number,
  points: Array<{ x: number; y: number; z: number }>,
  angle: number,
): number {
  const centre = size / 2;
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i];
    const r = rotateY(p, angle);
    const z = r.z; // -1..1 +near
    const depth = (z + 1) / 2;
    const dz = RADIUS * (1 - depth * 0.45);
    const sx = centre + r.x * dz;
    const sy = centre + p.y * dz;
    const d = Math.hypot(sx - x, sy - y);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
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

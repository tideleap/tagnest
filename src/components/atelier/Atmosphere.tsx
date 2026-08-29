import { useEffect, useRef } from 'react';

/**
 * Atmosphere — the living "art canvas" that sits behind every page.
 *
 * A generative particle field rendered on a 2D canvas: hundreds of slowly
 * drifting motes that bend toward the cursor and link with faint threads when
 * they cluster. Colours are sampled from the active theme's brand tokens, so the
 * field re-skins itself whenever the user switches palette — no app changes
 * needed. This is the "advanced rendering logic" layer of the redesign.
 *
 * Performance contract:
 *   - DPR capped at 2, particle count scaled to viewport area.
 *   - rAF loop pauses when the tab is hidden.
 *   - resize is coalesced through rAF: mobile keyboards opening/closing fire
 *     a burst of resize events and each uncoalesced run rebuilds the whole
 *     mote array mid-storm.
 *   - prefers-reduced-motion → a single static frame, no animation.
 *   - pointer position is read from a ref (no React re-renders per move).
 */
interface Mote {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  depth: number;
}

export function Atmosphere() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Resolve theme colours live (they change with [data-theme]).
    const readColor = (name: string, fallback: string) => {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    };
    let brand = readColor('--color-brand', '#6366f1');
    let accent = readColor('--color-brand-accent', '#8b5cf6');

    let width = 0;
    let height = 0;
    let dpr = 1;
    let motes: Mote[] = [];
    const pointer = { x: -9999, y: -9999, active: false };

    const isDark =
      getComputedStyle(document.documentElement).getPropertyValue('color-scheme').includes('dark') ||
      ['dark', 'aurora'].includes(document.documentElement.dataset.theme ?? '');

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const target = Math.min(120, Math.max(40, Math.round((width * height) / 16000)));
      motes = Array.from({ length: target }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.18,
        vy: (Math.random() - 0.5) * 0.18,
        r: 0.6 + Math.random() * 1.8,
        depth: 0.3 + Math.random() * 0.7,
      }));
    };

    const drawStatic = () => {
      ctx.clearRect(0, 0, width, height);
      // A calm radial brand wash — visual interest without motion.
      const g = ctx.createRadialGradient(width * 0.5, height * 0.2, 0, width * 0.5, height * 0.2, height);
      g.addColorStop(0, isDark ? 'rgba(99,102,241,0.10)' : 'rgba(99,102,241,0.06)');
      g.addColorStop(1, 'transparent');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, width, height);
      for (const m of motes) {
        ctx.beginPath();
        ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
        ctx.fillStyle = isDark ? accent : brand;
        ctx.globalAlpha = 0.25 * m.depth;
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };

    let raf = 0;
    let t = 0;
    const tick = () => {
      t += 0.0025;
      ctx.clearRect(0, 0, width, height);

      // Cursor halo.
      if (pointer.active) {
        const hg = ctx.createRadialGradient(pointer.x, pointer.y, 0, pointer.x, pointer.y, 220);
        hg.addColorStop(0, isDark ? 'rgba(139,92,246,0.10)' : 'rgba(99,102,241,0.08)');
        hg.addColorStop(1, 'transparent');
        ctx.fillStyle = hg;
        ctx.fillRect(pointer.x - 220, pointer.y - 220, 440, 440);
      }

      for (const m of motes) {
        // Flow-field drift — a smooth pseudo-noise from layered sines.
        const fx = Math.cos(m.y * 0.0016 + t) * 0.06 * m.depth;
        const fy = Math.sin(m.x * 0.0016 - t) * 0.06 * m.depth;
        m.vx += fx * 0.02;
        m.vy += fy * 0.02;

        if (pointer.active) {
          const dx = pointer.x - m.x;
          const dy = pointer.y - m.y;
          const dist = Math.hypot(dx, dy);
          if (dist < 180) {
            const pull = (1 - dist / 180) * 0.5;
            m.vx += (dx / (dist || 1)) * pull * 0.06;
            m.vy += (dy / (dist || 1)) * pull * 0.06;
          }
        }

        // Damping keeps speeds gentle.
        m.vx *= 0.96;
        m.vy *= 0.96;
        m.x += m.vx;
        m.y += m.vy;

        // Wrap around edges.
        if (m.x < -20) m.x = width + 20;
        if (m.x > width + 20) m.x = -20;
        if (m.y < -20) m.y = height + 20;
        if (m.y > height + 20) m.y = -20;

        ctx.beginPath();
        ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
        ctx.fillStyle = isDark ? accent : brand;
        ctx.globalAlpha = 0.32 * m.depth;
        ctx.fill();
      }

      // Faint thread links between nearby motes (capped for cost).
      ctx.globalAlpha = 1;
      ctx.lineWidth = 0.5;
      for (let i = 0; i < motes.length; i += 1) {
        for (let j = i + 1; j < Math.min(i + 6, motes.length); j += 1) {
          const a = motes[i];
          const b = motes[j];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d < 96) {
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.strokeStyle = isDark ? accent : brand;
            ctx.globalAlpha = (1 - d / 96) * 0.12;
            ctx.stroke();
          }
        }
      }
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(tick);
    };

    const onMove = (e: PointerEvent) => {
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      pointer.active = true;
    };
    const onLeave = () => {
      pointer.active = false;
    };
    const onVisibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(raf);
        raf = 0;
      } else if (!reduce && !raf) {
        raf = requestAnimationFrame(tick);
      }
    };

    // rAF-coalesced resize: the last event in a burst wins, and canvas
    // reallocation + mote rebuild happen at most once per frame.
    let resizeRaf = 0;
    const onResize = () => {
      if (resizeRaf) return;
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = 0;
        resize();
        if (reduce) drawStatic();
      });
    };

    resize();
    window.addEventListener('resize', onResize);
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerout', onLeave);
    document.addEventListener('visibilitychange', onVisibility);

    // Re-read colours shortly after mount in case the theme applied late.
    const colorTimer = window.setTimeout(() => {
      brand = readColor('--color-brand', brand);
      accent = readColor('--color-brand-accent', accent);
    }, 60);

    if (reduce) {
      drawStatic();
    } else {
      raf = requestAnimationFrame(tick);
    }

    return () => {
      cancelAnimationFrame(raf);
      cancelAnimationFrame(resizeRaf);
      window.clearTimeout(colorTimer);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerout', onLeave);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return (
    <>
      <canvas ref={canvasRef} className="atelier-atmosphere" aria-hidden />
      <div className="atelier-grain" aria-hidden />
      <div className="atelier-vignette" aria-hidden />
    </>
  );
}

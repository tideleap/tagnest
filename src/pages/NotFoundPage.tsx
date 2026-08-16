import { Link } from 'react-router-dom';
import { ArrowLeft, Compass } from 'lucide-react';
import { Button } from '@/components/ui';
import { KineticText, Magnetic, ScrambleText } from '@/components/atelier';

const WORDS = ['迷路了', 'Lost', '空无一物', 'Void', '404', '断掉的链接', 'Drift', '回到巢中'];

export function NotFoundPage() {
  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden px-6 text-center">
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute left-1/2 top-1/3 h-96 w-96 -translate-x-1/2 rounded-full bg-brand-soft/50 blur-[100px]" />
      </div>

      <div className="relative">
        <p className="atelier-eyebrow mb-4 justify-center">页面不存在 / Not Found</p>

        <h1 className="atelier-display atelier-display--1 leading-none">
          <span className="atelier-stroke">4</span>
          <span className="atelier-gradient-text">0</span>
          <span className="atelier-stroke">4</span>
        </h1>

        <p className="mx-auto mt-6 max-w-md text-base leading-relaxed text-ink-soft">
          <ScrambleText text="你寻找的页面飘走了，也许链接已失效。" duration={1000} />
        </p>

        <div className="mt-9">
          <Magnetic strength={0.3}>
            <Link to="/library/inbox">
              <Button variant="primary" size="lg" iconLeft={<ArrowLeft size={17} aria-hidden />}>
                回到收件箱
              </Button>
            </Link>
          </Magnetic>
        </div>

        <p className="mt-6 inline-flex items-center gap-2 text-2xs text-ink-faint">
          <Compass size={14} aria-hidden /> 或者随便逛逛下面的关键词
        </p>
      </div>

      <div className="absolute bottom-0 left-0 right-0 py-6">
        <KineticText duration={32} separator={<span className="text-brand-accent">/</span>}>
          {WORDS.map((w) => (
            <span key={w} className="text-sm font-medium tracking-wide text-ink-faint">
              {w}
            </span>
          ))}
        </KineticText>
      </div>
    </div>
  );
}

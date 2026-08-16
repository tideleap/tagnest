import { Reveal } from '@/components/atelier';

export function Card({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Reveal as="section" className="mb-4">
      <div className="spotlight rounded-xl border border-line bg-surface/85 p-5 shadow-raised backdrop-blur-sm">
        <h2 className="font-display text-[0.95rem] font-semibold tracking-tight text-ink">
          {title}
        </h2>
        {description && (
          <p className="mt-1 text-xs leading-relaxed text-ink-soft">{description}</p>
        )}
        <div className="mt-4">{children}</div>
      </div>
    </Reveal>
  );
}

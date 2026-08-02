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
    <section className="mb-4 rounded-md border border-line bg-surface p-4">
      <h2 className="text-sm font-semibold text-ink">{title}</h2>
      {description && <p className="mt-1 text-xs leading-relaxed text-ink-soft">{description}</p>}
      <div className="mt-3.5">{children}</div>
    </section>
  );
}

import { useMemo, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { Input, TagChip } from '@/components/ui';
import { useTags } from '@/hooks/queries';

export interface TagPickerProps {
  value: string[];
  onChange: (next: string[]) => void;
  label?: string;
  hint?: string;
}

/**
 * Free-text tag entry with suggestions.
 *
 * Names rather than IDs, so a bookmark can be tagged with something that does
 * not exist yet — the API creates missing tags on write. Requiring users to
 * create a tag first is the fastest way to make them stop tagging.
 */
export function TagPicker({ value, onChange, label = '标签', hint }: TagPickerProps) {
  const { data: tags } = useTags();
  const [draft, setDraft] = useState('');
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const suggestions = useMemo(() => {
    const lower = draft.trim().toLowerCase();
    return (tags ?? [])
      .filter((t) => !value.some((v) => v.toLowerCase() === t.name.toLowerCase()))
      .filter((t) => (lower ? t.name.toLowerCase().includes(lower) : true))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);
  }, [tags, draft, value]);

  const add = (name: string) => {
    const trimmed = name.trim().replace(/^#/, '');
    if (!trimmed) return;
    if (value.some((v) => v.toLowerCase() === trimmed.toLowerCase())) {
      setDraft('');
      return;
    }
    onChange([...value, trimmed]);
    setDraft('');
  };

  const remove = (name: string) => onChange(value.filter((v) => v !== name));

  return (
    <div className="flex flex-col gap-2">
      <Input
        ref={inputRef}
        label={label}
        hint={hint ?? '回车添加，退格删除最后一个'}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => window.setTimeout(() => setFocused(false), 120)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            add(draft);
          } else if (e.key === 'Backspace' && draft === '' && value.length > 0) {
            onChange(value.slice(0, -1));
          }
        }}
        placeholder="添加标签…"
        slotRight={
          draft.trim() ? (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => add(draft)}
              aria-label={`添加标签 ${draft}`}
              className="mr-0.5 flex h-7 w-7 items-center justify-center rounded-sm text-ink-faint hover:bg-surface-hover hover:text-ink"
            >
              <Plus size={15} />
            </button>
          ) : undefined
        }
      />

      {value.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {value.map((name) => {
            const known = tags?.find((t) => t.name.toLowerCase() === name.toLowerCase());
            return (
              <li key={name}>
                <TagChip
                  name={name}
                  colorIndex={known?.colorIndex ?? 0}
                  size="sm"
                  onRemove={() => remove(name)}
                />
              </li>
            );
          })}
        </ul>
      )}

      {focused && suggestions.length > 0 && (
        <div>
          <p className="mb-1.5 text-2xs font-medium uppercase tracking-wide text-ink-faint">建议</p>
          <ul className="flex flex-wrap gap-1.5">
            {suggestions.map((t) => (
              <li key={t.id}>
                <TagChip
                  name={t.name}
                  colorIndex={t.colorIndex}
                  count={t.count}
                  size="sm"
                  onClick={() => {
                    add(t.name);
                    inputRef.current?.focus();
                  }}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

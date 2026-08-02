import { Kbd } from '@/components/ui';
import { SHORTCUTS } from '@/hooks/useGlobalHotkeys';
import { Card } from './Card';

export function ShortcutsSection() {
  const groups = [...new Set(SHORTCUTS.map((s) => s.group))];

  return (
    <>
      {groups.map((group) => (
        <Card key={group} title={group}>
          <ul className="flex flex-col gap-2">
            {SHORTCUTS.filter((s) => s.group === group).map((shortcut) => (
              <li
                key={shortcut.description}
                className="flex items-center justify-between gap-4 text-sm"
              >
                <span className="text-ink-soft">{shortcut.description}</span>
                <span className="flex shrink-0 gap-1">
                  {shortcut.keys.map((key) => (
                    <Kbd key={key}>{key}</Kbd>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </>
  );
}

import { NavLink, useParams } from 'react-router-dom';
import {
  Camera,
  Database,
  Info,
  KeyRound,
  Keyboard,
  ListChecks,
  Palette,
  Share2,
  Sparkles,
  Timer,
  User,
} from 'lucide-react';
import { cx } from '@/lib/cx';
import { AccountSection } from './settings/AccountSection';
import { ApiKeysSection } from './settings/ApiKeysSection';
import { SharesSection } from './settings/SharesSection';
import { AppearanceSection } from './settings/AppearanceSection';
import { AiSection } from './settings/AiSection';
import { AutoClearSection } from './settings/AutoClearSection';
import { SnapshotsSection } from './settings/SnapshotsSection';
import { StorageSection } from './settings/StorageSection';
import { JobsSection } from './settings/JobsSection';
import { ShortcutsSection } from './settings/ShortcutsSection';
import { AboutSection } from './settings/AboutSection';

const SECTIONS = [
  { id: 'account', label: '账户', icon: User },
  { id: 'keys', label: '密钥', icon: KeyRound },
  { id: 'shares', label: '分享', icon: Share2 },
  { id: 'appearance', label: '外观', icon: Palette },
  { id: 'ai', label: 'AI 助手', icon: Sparkles },
  { id: 'jobs', label: '任务', icon: ListChecks },
  { id: 'snapshots', label: '快照', icon: Camera },
  { id: 'storage', label: '存储', icon: Database },
  { id: 'autoclear', label: '自动清空', icon: Timer },
  { id: 'shortcuts', label: '快捷键', icon: Keyboard },
  { id: 'about', label: '关于', icon: Info },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

export function SettingsPage() {
  const { section } = useParams();
  const active: SectionId = SECTIONS.some((s) => s.id === section)
    ? (section as SectionId)
    : 'account';

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-5 lg:flex-row lg:gap-8">
      <nav aria-label="设置分区" className="shrink-0 lg:w-44">
        <h1 className="mb-3 text-lg font-semibold text-ink">设置</h1>
        <ul className="flex gap-1 overflow-x-auto scrollbar-slim lg:flex-col">
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <li key={id} className="shrink-0">
              <NavLink
                to={`/settings/${id}`}
                className={cx(
                  'flex h-9 items-center gap-2 rounded-md px-3 text-sm font-medium transition-colors',
                  active === id
                    ? 'bg-brand-soft text-brand-ink'
                    : 'text-ink-soft hover:bg-surface-hover hover:text-ink',
                )}
              >
                <Icon size={16} aria-hidden />
                {label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <div className="min-w-0 flex-1">
        {active === 'account' && <AccountSection />}
        {active === 'keys' && <ApiKeysSection />}
        {active === 'shares' && <SharesSection />}
        {active === 'appearance' && <AppearanceSection />}
        {active === 'ai' && <AiSection />}
        {active === 'jobs' && <JobsSection />}
        {active === 'snapshots' && <SnapshotsSection />}
        {active === 'storage' && <StorageSection />}
        {active === 'autoclear' && <AutoClearSection />}
        {active === 'shortcuts' && <ShortcutsSection />}
        {active === 'about' && <AboutSection />}
      </div>
    </div>
  );
}

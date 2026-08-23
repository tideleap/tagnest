import { useMemo, useState } from 'react';
import { AlertTriangle, Check, ExternalLink, FolderTree, Pencil, Sparkles, X } from 'lucide-react';
import type { AiSuggestion } from '@shared/types';
import { Badge, Button, ConfirmDialog, EmptyState, SegmentedControl, Skeleton } from '@/components/ui';
import { cx } from '@/lib/cx';
import { useDecideSuggestions } from '@/hooks/queries/organize';
import { displayHost } from '@/lib/url';

/**
 * The review queue — where AI output becomes library data, or does not.
 *
 * ## Why this screen is the point of the refactor
 *
 * The model used to write tags straight into the library. That made every
 * proposal irreversible and unattributed, so the only responsible setting was
 * "off" — and off is exactly where the feature sat. Routing everything through
 * an explicit confirmation is what allows the model to be given far more
 * work: it can now run on every save, every import, and across the whole
 * library on demand, because none of it lands without a human yes.
 *
 * ## Grouping by bookmark, not by tag
 *
 * A flat list of 400 (bookmark, tag) rows is unreviewable — you cannot judge
 * "React" without seeing what it was proposed for, and you would see the same
 * bookmark six times. Grouping puts one decision in front of the user at a
 * time with the evidence attached.
 *
 * ## Phase 4: edit, topic grouping, safety threshold
 *
 *  - Each tag can be renamed before accepting; the new spelling is recorded as
 *    a `modified` event so future runs prefer it (the "越用越准" loop).
 *  - The queue can be re-grouped by the model-assigned `topic`, so a user who
 *    only cares about one subject can accept/reject it in one action.
 *  - "全部应用" warns how many tags and new labels it will write; "安全应用"
 *    only applies proposals at or above the confidence threshold.
 */

interface Props {
  suggestions: AiSuggestion[];
  loading?: boolean;
  /** The queue could not be fetched — distinct from "the queue is empty". */
  failed?: boolean;
  onRetry?: () => void;
  /**
   * CategorySync (C2-2): which proposal queue this view is reviewing. 'tag'
   * (default) shows loose-label proposals; 'category' shows single-placement
   * category paths. The value is forwarded on every accept/reject so the
   * server writes to the right store (`bookmark_tags` vs
   * `bookmark_primary_category`).
   */
  kind?: 'tag' | 'category';
}

interface Group {
  bookmarkId: string;
  title: string;
  url: string;
  items: AiSuggestion[];
  /** Highest confidence in the group, used for ordering. */
  top: number;
  /** Topic phrase for the bookmark (shared by all rows of the group). */
  topic: string | null;
  /** Model flagged this proposal as needing a human sanity check. */
  needsReview: boolean;
}

interface TopicGroup {
  topic: string;
  items: AiSuggestion[];
  top: number;
}

interface HierarchyGroup {
  /** Top-level category, e.g. "开发技术". */
  category: string;
  subcategories: Array<{
    name: string;
    items: AiSuggestion[];
    top: number;
  }>;
  /** Direct children of the category with no subcategory. */
  direct: AiSuggestion[];
  top: number;
}

function groupByHierarchy(suggestions: AiSuggestion[]): HierarchyGroup[] {
  const map = new Map<string, { subs: Map<string, AiSuggestion[]>; direct: AiSuggestion[] }>();

  for (const item of suggestions) {
    const category = item.category ?? '未分类';
    const held = map.get(category);
    if (item.subcategory) {
      if (held) {
        const sub = held.subs.get(item.subcategory) ?? [];
        sub.push(item);
        held.subs.set(item.subcategory, sub);
      } else {
        map.set(category, { subs: new Map([[item.subcategory, [item]]]), direct: [] });
      }
    } else {
      if (held) held.direct.push(item);
      else map.set(category, { subs: new Map(), direct: [item] });
    }
  }

  return [...map.entries()]
    .map(([category, { subs, direct }]) => {
      const subcategories = [...subs.entries()]
        .map(([name, items]) => ({ name, items, top: Math.max(...items.map((i) => i.confidence)) }))
        .sort((a, b) => b.items.length - a.items.length || b.top - a.top);
      const directTop = direct.length > 0 ? Math.max(...direct.map((i) => i.confidence)) : 0;
      const top = Math.max(
        directTop,
        subcategories.length > 0 ? Math.max(...subcategories.map((s) => s.top)) : 0,
      );
      return { category, subcategories, direct, top };
    })
    .sort((a, b) => b.top - a.top || a.category.localeCompare(b.category, 'zh-CN'));
}

/** Below this a proposal is shown but flagged as a guess. */
const LOW_CONFIDENCE = 0.55;

/** Only proposals at or above this are touched by the "安全应用" action. */
const SAFE_THRESHOLD = 0.8;

const SOURCE_LABEL: Record<string, string> = {
  model: '模型',
  fallback: '域名兜底',
  taxonomy: '标签体系',
};

function groupByBookmark(suggestions: AiSuggestion[]): Group[] {
  const map = new Map<string, Group>();

  for (const item of suggestions) {
    const held = map.get(item.bookmarkId);
    if (held) {
      held.items.push(item);
      held.top = Math.max(held.top, item.confidence);
      continue;
    }
    map.set(item.bookmarkId, {
      bookmarkId: item.bookmarkId,
      title: item.bookmarkTitle,
      url: item.bookmarkUrl,
      items: [item],
      top: item.confidence,
      topic: item.topic ?? null,
      needsReview: item.needsReview,
    });
  }

  // Strongest first: the user builds trust on the obvious ones before hitting
  // the borderline cases, which is also the order in which "accept all" is
  // least likely to be regretted.
  return [...map.values()].sort((a, b) => b.top - a.top);
}

function groupByTopic(suggestions: AiSuggestion[]): TopicGroup[] {
  const map = new Map<string, TopicGroup>();
  for (const item of suggestions) {
    const key = item.topic ?? '未分类';
    const held = map.get(key);
    if (held) {
      held.items.push(item);
      held.top = Math.max(held.top, item.confidence);
      continue;
    }
    map.set(key, { topic: key, items: [item], top: item.confidence });
  }
  // Most-covered topic first — the ones worth reviewing as a unit.
  return [...map.values()].sort((a, b) => b.items.length - a.items.length || b.top - a.top);
}

export function SuggestionReview({ suggestions, loading, failed, onRetry, kind = 'tag' }: Props) {
  const decide = useDecideSuggestions();
  const isCategory = kind === 'category';
  // Locally hidden groups: the server round trip is fast but not instant, and
  // a card that lingers after a click reads as a broken button.
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [grouping, setGrouping] = useState<'bookmark' | 'topic' | 'hierarchy'>('bookmark');
  const [confirmAll, setConfirmAll] = useState(false);

  const visible = useMemo(
    () => suggestions.filter((s) => !dismissed.has(s.bookmarkId)),
    [suggestions, dismissed],
  );

  const groups = useMemo(() => groupByBookmark(visible), [visible]);
  const topicGroups = useMemo(() => groupByTopic(visible), [visible]);
  const hierarchyGroups = useMemo(() => groupByHierarchy(visible), [visible]);

  const allIds = useMemo(() => visible.map((s) => s.id), [visible]);
  const safeIds = useMemo(
    () => visible.filter((s) => s.confidence >= SAFE_THRESHOLD).map((s) => s.id),
    [visible],
  );
  const newTagCount = useMemo(
    () => new Set(visible.filter((s) => !s.tagId).map((s) => s.tagName.toLowerCase())).size,
    [visible],
  );

  const hide = (bookmarkId: string) =>
    setDismissed((prev) => new Set(prev).add(bookmarkId));

  const acceptOne = (item: AiSuggestion) => {
    hide(item.bookmarkId);
    decide.mutate({ action: 'accept', ids: [item.id], kind });
  };
  const rejectOne = (item: AiSuggestion) => {
    hide(item.bookmarkId);
    decide.mutate({ action: 'reject', ids: [item.id], kind });
  };
  const renameOne = (item: AiSuggestion, name: string) => {
    hide(item.bookmarkId);
    decide.mutate({ action: 'accept', ids: [item.id], renameTo: name, kind });
  };

  const applyByIds = (ids: string[]) => {
    if (ids.length === 0) return;
    const bookmarkIds = new Set(
      visible.filter((s) => ids.includes(s.id)).map((s) => s.bookmarkId),
    );
    setDismissed((prev) => {
      const next = new Set(prev);
      bookmarkIds.forEach((id) => next.add(id));
      return next;
    });
    decide.mutate({ action: 'accept', ids, kind });
  };
  const rejectByIds = (ids: string[]) => {
    if (ids.length === 0) return;
    const bookmarkIds = new Set(
      visible.filter((s) => ids.includes(s.id)).map((s) => s.bookmarkId),
    );
    setDismissed((prev) => {
      const next = new Set(prev);
      bookmarkIds.forEach((id) => next.add(id));
      return next;
    });
    decide.mutate({ action: 'reject', ids, kind });
  };

  if (loading) {
    return (
      <ul className="flex flex-col gap-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <li key={i}>
            <Skeleton className="h-24 w-full rounded-md" />
          </li>
        ))}
      </ul>
    );
  }

  // A failed fetch must not masquerade as an empty queue: telling the user
  // "没有待确认的建议" hides the fault and they will never think to retry.
  if (failed) {
    return (
      <EmptyState
        icon={<AlertTriangle size={22} />}
        title="建议列表加载失败"
        description="没能读取到 AI 生成的标签建议，已生成的建议不会丢失。稍后重试即可。"
        action={
          onRetry ? (
            <Button variant="secondary" onClick={onRetry}>
              重试
            </Button>
          ) : undefined
        }
      />
    );
  }

  if (groups.length === 0) {
    return (
      <EmptyState
        icon={<Sparkles size={22} />}
        title="没有待确认的建议"
        description={
          isCategory
            ? '运行一次「精确分类」，AI 会在这里列出它为每条书签推荐的唯一分类路径，确认后才会写入。'
            : '运行一次整理，AI 会在这里列出它为每条书签推荐的标签，确认后才会写入。'
        }
      />
    );
  }

  const totalTags = visible.length;
  const unit = isCategory ? '分类' : '标签';

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-ink-faint">
          {grouping === 'topic'
            ? `${topicGroups.length} 个主题 · ${totalTags} 个待确认${unit}`
            : grouping === 'hierarchy'
              ? `${hierarchyGroups.length} 个大类 · ${totalTags} 个待确认${unit}`
              : `${groups.length} 条书签 · ${totalTags} 个待确认${unit}`}
        </p>
        <SegmentedControl
          label="分组方式"
          size="sm"
          value={grouping}
          onChange={(value) => setGrouping(value as 'bookmark' | 'topic' | 'hierarchy')}
          segments={[
            { value: 'bookmark', label: '按书签' },
            { value: 'topic', label: '按主题' },
            { value: 'hierarchy', label: '按层级' },
          ]}
        />
        <div className="ml-auto flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={decide.isPending || safeIds.length === 0}
            onClick={() => applyByIds(safeIds)}
          >
            安全应用（≥80%，{safeIds.length}）
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={decide.isPending}
            onClick={() => rejectByIds(allIds)}
          >
            全部忽略
          </Button>
          <Button
            size="sm"
            variant="primary"
            iconLeft={<Check size={15} />}
            loading={decide.isPending}
            onClick={() => setConfirmAll(true)}
          >
            全部应用
          </Button>
        </div>
      </div>

      {grouping === 'topic' ? (
        <TopicGroupList
          groups={topicGroups}
          acceptOne={acceptOne}
          rejectOne={rejectOne}
          renameOne={renameOne}
          applyByIds={applyByIds}
          rejectByIds={rejectByIds}
          decidePending={decide.isPending}
        />
      ) : grouping === 'hierarchy' ? (
        <HierarchyGroupList
          groups={hierarchyGroups}
          acceptOne={acceptOne}
          rejectOne={rejectOne}
          renameOne={renameOne}
          applyByIds={applyByIds}
          rejectByIds={rejectByIds}
          decidePending={decide.isPending}
        />
      ) : (
        <BookmarkGroupList
          groups={groups}
          acceptOne={acceptOne}
          rejectOne={rejectOne}
          renameOne={renameOne}
          applyByIds={applyByIds}
          rejectByIds={rejectByIds}
          decidePending={decide.isPending}
        />
      )}

      <ConfirmDialog
        open={confirmAll}
        onClose={() => setConfirmAll(false)}
        onConfirm={() => {
          setConfirmAll(false);
          applyByIds(allIds);
        }}
        title={isCategory ? '确认应用全部分类建议' : '确认应用全部标签建议'}
        tone="default"
        confirmLabel="全部应用"
        message={
          isCategory ? (
            <span>
              将为 <b>{allIds.length}</b> 条书签写入唯一主分类。确认后这些建议会立即写入，
              且无法一次性撤销。
            </span>
          ) : (
            <span>
              将写入 <b>{allIds.length}</b> 条标签关联
              {newTagCount > 0 && (
                <>
                  ，其中 <b>{newTagCount}</b> 个为新标签（将在标签体系中新建）
                </>
              )}
              。确认后这些建议会立即写入书签，且无法一次性撤销。
            </span>
          )
        }
      />
    </div>
  );
}

function BookmarkGroupList({
  groups,
  acceptOne,
  rejectOne,
  renameOne,
  applyByIds,
  rejectByIds,
}: {
  groups: Group[];
  acceptOne: (item: AiSuggestion) => void;
  rejectOne: (item: AiSuggestion) => void;
  renameOne: (item: AiSuggestion, name: string) => void;
  applyByIds: (ids: string[]) => void;
  rejectByIds: (ids: string[]) => void;
  decidePending: boolean;
}) {
  return (
    <ul className="flex flex-col gap-2">
      {groups.map((group) => (
        <li
          key={group.bookmarkId}
          className="spotlight rounded-xl border border-line bg-surface/85 p-3.5 shadow-raised backdrop-blur-sm transition-colors hover:border-brand-accent"
        >
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-ink">{group.title || group.url}</p>
              <a
                href={group.url}
                target="_blank"
                rel="noreferrer noopener"
                className="mt-0.5 inline-flex items-center gap-1 text-2xs text-ink-faint hover:text-ink-soft"
              >
                {displayHost(group.url)}
                <ExternalLink size={11} aria-hidden />
              </a>
              {(group.topic || group.needsReview) && (
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {group.topic && (
                    <span className="inline-flex items-center gap-1 rounded-md bg-sunken px-1.5 py-0.5 text-2xs text-ink-soft">
                      <Sparkles size={11} aria-hidden />
                      {group.topic}
                    </span>
                  )}
                  {group.needsReview && (
                    <span className="inline-flex items-center gap-1 rounded-md border border-dashed border-caution/60 px-1.5 py-0.5 text-2xs text-caution">
                      <AlertTriangle size={11} aria-hidden />
                      需复核
                    </span>
                  )}
                </div>
              )}
            </div>

            <div className="flex shrink-0 gap-1.5">
              <Button
                size="sm"
                variant="ghost"
                iconLeft={<X size={14} />}
                onClick={() => rejectByIds(group.items.map((i) => i.id))}
              >
                忽略
              </Button>
              <Button
                size="sm"
                variant="secondary"
                iconLeft={<Check size={14} />}
                onClick={() => applyByIds(group.items.map((i) => i.id))}
              >
                全部接受
              </Button>
            </div>
          </div>

          <ul className="mt-2.5 flex flex-wrap gap-1.5">
            {group.items.map((item) => (
              <li key={item.id}>
                <TagProposal
                  item={item}
                  onAccept={() => acceptOne(item)}
                  onReject={() => rejectOne(item)}
                  onRename={(name) => renameOne(item, name)}
                />
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

function TopicGroupList({
  groups,
  acceptOne,
  rejectOne,
  renameOne,
  applyByIds,
  rejectByIds,
  decidePending,
}: {
  groups: TopicGroup[];
  acceptOne: (item: AiSuggestion) => void;
  rejectOne: (item: AiSuggestion) => void;
  renameOne: (item: AiSuggestion, name: string) => void;
  applyByIds: (ids: string[]) => void;
  rejectByIds: (ids: string[]) => void;
  decidePending: boolean;
}) {
  return (
    <ul className="flex flex-col gap-3">
      {groups.map((tg) => (
        <li
          key={tg.topic}
          className="spotlight rounded-xl border border-line bg-surface/85 p-3.5 shadow-raised backdrop-blur-sm transition-colors hover:border-brand-accent"
        >
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1 rounded-md bg-sunken px-1.5 py-0.5 text-xs font-medium text-ink-soft">
              <Sparkles size={12} aria-hidden />
              {tg.topic}
            </span>
            <span className="text-2xs text-ink-faint">{tg.items.length} 条建议</span>
            <div className="ml-auto flex gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={decidePending}
                onClick={() => rejectByIds(tg.items.map((i) => i.id))}
              >
                忽略本主题
              </Button>
              <Button
                size="sm"
                variant="secondary"
                iconLeft={<Check size={14} />}
                disabled={decidePending}
                onClick={() => applyByIds(tg.items.map((i) => i.id))}
              >
                应用本主题
              </Button>
            </div>
          </div>
          <ul className="mt-2.5 flex flex-wrap gap-1.5">
            {tg.items.map((item) => (
              <li key={item.id}>
                <TagProposal
                  item={item}
                  onAccept={() => acceptOne(item)}
                  onReject={() => rejectOne(item)}
                  onRename={(name) => renameOne(item, name)}
                />
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

function HierarchyGroupList({
  groups,
  acceptOne,
  rejectOne,
  renameOne,
  applyByIds,
  rejectByIds,
  decidePending,
}: {
  groups: HierarchyGroup[];
  acceptOne: (item: AiSuggestion) => void;
  rejectOne: (item: AiSuggestion) => void;
  renameOne: (item: AiSuggestion, name: string) => void;
  applyByIds: (ids: string[]) => void;
  rejectByIds: (ids: string[]) => void;
  decidePending: boolean;
}) {
  return (
    <ul className="flex flex-col gap-3">
      {groups.map((hg) => {
        const allItems = [...hg.direct, ...hg.subcategories.flatMap((s) => s.items)];
        return (
          <li
            key={hg.category}
            className="spotlight rounded-xl border border-line bg-surface/85 p-3.5 shadow-raised backdrop-blur-sm transition-colors hover:border-brand-accent"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1 rounded-md bg-brand-soft px-1.5 py-0.5 text-xs font-medium text-brand-ink">
                <FolderTree size={12} aria-hidden />
                {hg.category}
              </span>
              <span className="text-2xs text-ink-faint">{allItems.length} 条建议</span>
              <div className="ml-auto flex gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={decidePending}
                  onClick={() => rejectByIds(allItems.map((i) => i.id))}
                >
                  忽略本类
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  iconLeft={<Check size={14} />}
                  disabled={decidePending}
                  onClick={() => applyByIds(allItems.map((i) => i.id))}
                >
                  应用本类
                </Button>
              </div>
            </div>

            <ul className="mt-2.5 flex flex-col gap-2">
              {hg.subcategories.map((sub) => (
                <li key={sub.name}>
                  <div className="mb-1 flex items-center gap-2">
                    <span className="text-2xs font-medium text-ink-soft">{sub.name}</span>
                    <span className="text-2xs text-ink-faint">{sub.items.length}</span>
                    <div className="ml-auto flex gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={decidePending}
                        onClick={() => rejectByIds(sub.items.map((i) => i.id))}
                      >
                        忽略
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={decidePending}
                        onClick={() => applyByIds(sub.items.map((i) => i.id))}
                      >
                        应用
                      </Button>
                    </div>
                  </div>
                  <ul className="flex flex-wrap gap-1.5">
                    {sub.items.map((item) => (
                      <li key={item.id}>
                        <TagProposal
                          item={item}
                          onAccept={() => acceptOne(item)}
                          onReject={() => rejectOne(item)}
                          onRename={(name) => renameOne(item, name)}
                        />
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
              {hg.direct.length > 0 && (
                <li>
                  <div className="mb-1 flex items-center gap-2">
                    <span className="text-2xs font-medium text-ink-soft">其他</span>
                    <span className="text-2xs text-ink-faint">{hg.direct.length}</span>
                    <div className="ml-auto flex gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={decidePending}
                        onClick={() => rejectByIds(hg.direct.map((i) => i.id))}
                      >
                        忽略
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={decidePending}
                        onClick={() => applyByIds(hg.direct.map((i) => i.id))}
                      >
                        应用
                      </Button>
                    </div>
                  </div>
                  <ul className="flex flex-wrap gap-1.5">
                    {hg.direct.map((item) => (
                      <li key={item.id}>
                        <TagProposal
                          item={item}
                          onAccept={() => acceptOne(item)}
                          onReject={() => rejectOne(item)}
                          onRename={(name) => renameOne(item, name)}
                        />
                      </li>
                    ))}
                  </ul>
                </li>
              )}
            </ul>
          </li>
        );
      })}
    </ul>
  );
}

function TagProposal({
  item,
  onAccept,
  onReject,
  onRename,
}: {
  item: AiSuggestion;
  onAccept: () => void;
  onReject: () => void;
  onRename: (name: string) => void;
}) {
  const [decided, setDecided] = useState<'accept' | 'reject' | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.tagName);
  const [label, setLabel] = useState(item.tagName);
  const low = item.confidence < LOW_CONFIDENCE;
  const percent = Math.round(item.confidence * 100);
  // CategorySync (C2-2): a category row proposes a placement path, not a free
  // label — renaming it would mean picking a different node, which is a
  // manual re-classification, not an edit. Hide the pencil for those rows.
  const isCategoryRow = item.kind === 'category';

  if (decided) {
    return (
      <span
        className={cx(
          'inline-flex h-7 items-center gap-1 rounded-md px-2 text-2xs',
          decided === 'accept' ? 'bg-positive-soft text-positive-ink' : 'bg-sunken text-ink-faint',
        )}
      >
        {decided === 'accept' ? <Check size={12} /> : <X size={12} />}
        {label}
      </span>
    );
  }

  if (editing) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md border border-line bg-surface px-1 py-0.5">
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const name = draft.trim();
              if (name && name !== item.tagName) {
                setLabel(name);
                setDecided('accept');
                onRename(name);
              } else {
                setEditing(false);
              }
            } else if (e.key === 'Escape') {
              setEditing(false);
            }
          }}
          className="w-24 rounded bg-canvas px-1.5 py-0.5 text-2xs text-ink outline-none ring-1 ring-line focus:ring-brand"
          aria-label={`编辑标签 ${item.tagName}`}
        />
        <button
          type="button"
          aria-label="确认修改"
          className="rounded p-1 text-positive-ink transition-colors hover:bg-positive-soft"
          onClick={() => {
            const name = draft.trim();
            if (name && name !== item.tagName) {
              setLabel(name);
              setDecided('accept');
              onRename(name);
            } else {
              setEditing(false);
            }
          }}
        >
          <Check size={12} />
        </button>
        <button
          type="button"
          aria-label="取消修改"
          className="rounded p-1 text-ink-faint transition-colors hover:bg-surface-hover"
          onClick={() => setEditing(false)}
        >
          <X size={12} />
        </button>
      </span>
    );
  }

  return (
    <span
      // The reason is the whole argument for trusting the tag; it is shown as a
      // tooltip and, when present, as a caption beneath the pill.
      title={item.reason ?? undefined}
      className={cx(
        'inline-flex flex-col items-start gap-0.5 rounded-md border pl-2 pr-1 text-2xs',
        low ? 'border-dashed border-caution/60 text-ink-soft' : 'border-line text-ink',
      )}
    >
      <span className="flex items-center gap-1">
        {isCategoryRow && <FolderTree size={11} aria-hidden className="text-brand-accent" />}
        <span className="font-medium">{label}</span>
        <span className="tabular-nums text-ink-faint">{percent}%</span>
        <Badge tone="neutral" className="hidden sm:inline-flex">
          {SOURCE_LABEL[item.source] ?? item.source}
        </Badge>
        {item.feedbackBoosted && (
          <span
            title="根据你的历史偏好，这条建议被提升了置信度"
            className="inline-flex items-center gap-0.5 rounded bg-positive-soft px-1 text-[10px] text-positive-ink"
          >
            <Sparkles size={10} aria-hidden />
            已学习
          </span>
        )}

        {!isCategoryRow && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            aria-label={`编辑标签 ${item.tagName}`}
            className="ml-0.5 rounded p-1 text-ink-faint transition-colors hover:bg-surface-hover hover:text-ink"
          >
            <Pencil size={12} />
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            setDecided('accept');
            onAccept();
          }}
          aria-label={`接受标签 ${item.tagName}`}
          className="rounded p-1 text-ink-faint transition-colors hover:bg-positive-soft hover:text-positive-ink"
        >
          <Check size={12} />
        </button>
        <button
          type="button"
          onClick={() => {
            setDecided('reject');
            onReject();
          }}
          aria-label={`忽略标签 ${item.tagName}`}
          className="rounded p-1 text-ink-faint transition-colors hover:bg-surface-hover hover:text-ink"
        >
          <X size={12} />
        </button>
      </span>
      {item.reason && (
        <span className="max-w-[14rem] text-[10px] leading-tight text-ink-faint">{item.reason}</span>
      )}
    </span>
  );
}

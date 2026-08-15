import { useNavigate } from 'react-router-dom';
import { Download, Plus, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui';
import { useOverlay } from '@/stores/ui';

/**
 * First-run wizard (MVP 4.1).
 *
 * Shown only while the library is empty. Instead of a modal that blocks the
 * first view, it is an inline three-step card on the dashboard — the user can
 * act on any step in any order, and the card disappears on its own the moment
 * the first bookmark lands (stats.bookmarks > 0), so there is no "done" flag
 * to persist or forget.
 */
export function OnboardingCard() {
  const navigate = useNavigate();
  const setQuickAddOpen = useOverlay((s) => s.setQuickAddOpen);

  const steps = [
    {
      icon: <Download size={18} aria-hidden />,
      title: '导入浏览器书签',
      desc: '把 Chrome / Edge / Firefox 里现有的书签一次搬进来，文件夹会自动变成标签。',
      action: (
        <Button size="sm" variant="primary" onClick={() => navigate('/import')}>
          去导入
        </Button>
      ),
    },
    {
      icon: <Plus size={18} aria-hidden />,
      title: '添加第一条书签',
      desc: '手动收藏一个常用网址，体验快速添加与自动抓取标题。',
      action: (
        <Button size="sm" variant="secondary" onClick={() => setQuickAddOpen(true)}>
          添加书签
        </Button>
      ),
    },
    {
      icon: <Sparkles size={18} aria-hidden />,
      title: '让 AI 帮你整理',
      desc: '有书签之后，AI 整理可以为未打标的书签生成标签建议，由你确认后写入。',
      action: (
        <Button size="sm" variant="ghost" onClick={() => navigate('/organize')}>
          了解 AI 整理
        </Button>
      ),
    },
  ];

  return (
    <section
      aria-label="开始使用"
      className="rounded-2xl border border-brand/30 bg-brand-soft/40 p-5 shadow-float"
    >
      <h2 className="text-base font-extrabold text-ink">欢迎使用 TagNest</h2>
      <p className="mt-1 text-xs leading-relaxed text-ink-soft">
        你的书签库还是空的。按下面任意一步开始，三步走完就能拥有一个整理好的私人知识库。
      </p>
      <ol className="mt-4 flex flex-col gap-3">
        {steps.map((step, i) => (
          <li
            key={step.title}
            className="flex items-start gap-3 rounded-xl border border-line bg-surface p-3.5"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand-ink">
              {step.icon}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-ink">
                {i + 1}. {step.title}
              </span>
              <span className="mt-0.5 block text-2xs leading-relaxed text-ink-faint">
                {step.desc}
              </span>
            </span>
            <span className="shrink-0">{step.action}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

import { useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Share2 } from 'lucide-react';
import { Button, Input, Textarea } from '@/components/ui';
import { Logo } from '@/components/decor/Logo';
import { useCreateBookmark } from '@/hooks/queries/bookmarks';
import { parseShareTarget } from '@/lib/shareTarget';
import { normalizeUrl } from '@/lib/url';
import { HttpError } from '@/lib/api';

/**
 * Web Share Target landing page (C4: mobile capture).
 *
 * Android's "Share → TagNest" navigates here with `url`/`title`/`text` query
 * params (see manifest.webmanifest `share_target`). The page turns them into
 * a bookmark draft, lets the user tweak title/note, and saves through the
 * regular create endpoint — no tags, so the bookmark lands in the inbox.
 *
 * Lives behind RequireAuth: a signed-out share is redirected to /signin with
 * this exact URL as the `from` target, so the params survive the round trip.
 */
export function ShareTargetPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const createBookmark = useCreateBookmark();

  const draft = useMemo(() => {
    const params = new URLSearchParams(location.search);
    return parseShareTarget({
      url: params.get('url'),
      title: params.get('title'),
      text: params.get('text'),
    });
  }, [location.search]);

  const [url, setUrl] = useState(draft.url ?? '');
  const [title, setTitle] = useState(draft.title);
  const [note, setNote] = useState(draft.note);
  const [urlError, setUrlError] = useState<string>();
  const [formError, setFormError] = useState<string>();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(undefined);

    const normalized = normalizeUrl(url);
    if (!normalized) {
      setUrlError('请输入合法的网址');
      return;
    }
    setUrlError(undefined);

    try {
      await createBookmark.mutateAsync({
        url: normalized,
        title: title.trim() || undefined,
        note: note.trim() || null,
      });
      navigate('/library/inbox', { replace: true });
    } catch (err) {
      if (err instanceof HttpError && err.status === 409) {
        // Duplicate share — the bookmark already exists. Not an error worth
        // blocking on; send the user to their library instead.
        navigate('/library/all', { replace: true });
        return;
      }
      setFormError(err instanceof Error ? err.message : '保存失败，请稍后重试');
    }
  };

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-canvas px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <Logo size={48} />
          <div>
            <h1 className="flex items-center justify-center gap-2 text-xl font-semibold tracking-tight text-ink">
              <Share2 size={18} className="text-brand-ink" aria-hidden />
              保存到 TagNest
            </h1>
            <p className="mt-1 text-sm text-ink-soft">
              {draft.url ? '确认信息后保存到收件箱' : '分享内容里没找到链接，手动填一下网址'}
            </p>
          </div>
        </div>

        <form
          onSubmit={submit}
          className="flex flex-col gap-3.5 rounded-lg border border-line bg-surface p-5 shadow-raised"
        >
          {formError && (
            <p
              role="alert"
              className="rounded-md border border-critical bg-critical-soft px-3 py-2 text-xs text-critical-ink"
            >
              {formError}
            </p>
          )}

          <Input
            label="网址"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            error={urlError}
            placeholder="https://example.com"
            inputMode="url"
            required
            autoFocus={!draft.url}
          />

          <Input
            label="标题"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="留空则自动抓取"
          />

          <Textarea
            label="笔记"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            maxLength={20000}
            placeholder="选填：分享文字会保留在这里"
          />

          <Button
            type="submit"
            variant="primary"
            size="lg"
            fullWidth
            loading={createBookmark.isPending}
            className="mt-1"
          >
            保存到收件箱
          </Button>
        </form>

        <p className="mt-4 text-center text-sm text-ink-soft">
          不想保存？{' '}
          <Link to="/library/inbox" className="font-medium text-brand-ink underline-offset-2 hover:underline">
            直接回书签库
          </Link>
        </p>
      </div>
    </div>
  );
}

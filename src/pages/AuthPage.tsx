import { useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  Bookmark,
  Brain,
  Camera,
  Clock,
  Shield,
  Sparkles,
  Tag,
} from 'lucide-react';
import { Button, Input } from '@/components/ui';
import { Logo } from '@/components/decor/Logo';
import { Magnetic, ScrambleText, KineticText } from '@/components/atelier';
import { useAuth } from '@/stores/auth';
import { HttpError } from '@/lib/api';

interface LocationState {
  from?: string;
}

function safeFromTarget(from: unknown): string | undefined {
  if (typeof from !== 'string' || from.length === 0) return undefined;
  if (!from.startsWith('/')) return undefined;
  if (from.startsWith('//')) return undefined;
  return from;
}

const FEATURES = [
  { icon: Tag, label: '智能标签体系' },
  { icon: Brain, label: 'AI 一键整理' },
  { icon: Camera, label: '网页快照时光机' },
  { icon: Clock, label: '时间线回顾' },
  { icon: Shield, label: '私密保险库' },
  { icon: Bookmark, label: '键盘优先检索' },
];

const MARQUEE_WORDS = ['书签', '标签', '快照', 'AI 整理', '时间线', '集合', '检索', '归档'];

export function AuthPage({ mode }: { mode: 'signin' | 'signup' }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { status, login, register } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  const isSignUp = mode === 'signup';

  useEffect(() => {
    setFieldErrors({});
    setFormError(undefined);
  }, [mode]);

  if (status === 'authenticated') {
    const from = safeFromTarget((location.state as LocationState | null)?.from);
    return <Navigate to={from ?? '/library/inbox'} replace />;
  }

  const validate = () => {
    const errors: Record<string, string> = {};
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = '请输入有效的邮箱地址';
    if (password.length < 8) errors.password = '密码至少 8 位';
    if (isSignUp && displayName.trim().length < 1) errors.displayName = '请填写显示名称';
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(undefined);
    if (!validate()) return;
    setSubmitting(true);
    try {
      if (isSignUp) await register(email.trim(), password, displayName.trim());
      else await login(email.trim(), password);
      navigate('/library/inbox', { replace: true });
    } catch (err) {
      if (err instanceof HttpError) {
        if (err.details) setFieldErrors(err.details);
        setFormError(err.message);
      } else {
        setFormError('发生了未知错误，请稍后重试');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="relative grid min-h-dvh lg:grid-cols-[1.05fr_1fr]">
      {/* Left — editorial statement panel (atmosphere canvas shows through). */}
      <aside className="relative hidden flex-col justify-between overflow-hidden border-r border-line/50 p-10 text-ink-inverse lg:flex xl:p-14">
        <div
          aria-hidden
          className="absolute inset-0 -z-10"
          style={{
            background:
              'radial-gradient(120% 90% at 15% 10%, color-mix(in oklab, var(--color-brand) 30%, transparent), transparent 55%), radial-gradient(120% 90% at 90% 90%, color-mix(in oklab, var(--color-brand-accent) 26%, transparent), transparent 55%), color-mix(in oklab, var(--color-canvas) 55%, #0b0f1a)',
          }}
        />
        <div className="flex items-center gap-3">
          <span className="logo-breathe">
            <Logo size={42} />
          </span>
          <span className="atelier-wordmark text-2xl text-white">TagNest</span>
        </div>

        <div className="max-w-xl">
          <p className="atelier-eyebrow mb-6 text-white/70">为书签，建一座巢</p>
          <h1 className="atelier-display atelier-display--1 text-white">
            <ScrambleText text="收藏即秩序。" duration={1100} />
          </h1>
          <p className="mt-6 max-w-md text-lg leading-relaxed text-white/70">
            一个键盘优先、AI 驱动的书签巢。把零散的链接，整理成可被检索、可被回看、可被收藏的秩序。
          </p>

          <ul className="mt-10 grid grid-cols-2 gap-x-6 gap-y-4">
            {FEATURES.map((f) => (
              <li key={f.label} className="flex items-center gap-3 text-sm text-white/80">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/10 ring-1 ring-white/15">
                  <f.icon size={17} aria-hidden />
                </span>
                {f.label}
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-10 border-t border-white/15 pt-6">
          <KineticText duration={28} separator={<Sparkles size={16} className="text-white/50" aria-hidden />}>
            {MARQUEE_WORDS.map((w) => (
              <span key={w} className="flex items-center gap-2.5 text-sm font-medium tracking-wide text-white/70">
                {w}
                <span className="text-white/30">/</span>
              </span>
            ))}
          </KineticText>
        </div>
      </aside>

      {/* Right — glass form. */}
      <main className="relative flex min-h-dvh items-center justify-center px-5 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <Logo size={40} />
            <span className="atelier-wordmark text-2xl text-ink">TagNest</span>
          </div>

          <div className="atelier-glass anim-atelier-enter rounded-[1.5rem] p-7 shadow-modal sm:p-8">
            <p className="atelier-eyebrow mb-3">{isSignUp ? '创建账户' : '欢迎回来'}</p>
            <h2 className="atelier-display atelier-display--3 text-ink">
              {isSignUp ? '开启你的书签巢' : '登录以继续'}
            </h2>
            <p className="mt-2 text-sm text-ink-soft">
              {isSignUp ? '几秒即可开始整理。' : '很高兴又见到你。'}
            </p>

            <form onSubmit={submit} className="mt-6 flex flex-col gap-4">
              {formError && (
                <p role="alert" className="rounded-lg border border-critical bg-critical-soft px-3 py-2 text-xs text-critical-ink">
                  {formError}
                </p>
              )}

              {isSignUp && (
                <Input
                  label="显示名称"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  error={fieldErrors.displayName}
                  autoComplete="nickname"
                  required
                />
              )}

              <Input
                label="邮箱"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                error={fieldErrors.email}
                autoComplete="email"
                inputMode="email"
                required
                autoFocus={!isSignUp}
              />

              <Input
                label="密码"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                error={fieldErrors.password}
                hint={isSignUp ? '至少 8 位字符' : undefined}
                autoComplete={isSignUp ? 'new-password' : 'current-password'}
                required
              />

              <Magnetic strength={0.3} className="mt-1 w-full">
                <Button type="submit" variant="primary" size="lg" fullWidth loading={submitting}>
                  {isSignUp ? '创建账户' : '登录'}
                  {!submitting && <ArrowRight size={17} aria-hidden />}
                </Button>
              </Magnetic>
            </form>

            <p className="mt-6 text-center text-sm text-ink-soft">
              {isSignUp ? '已经有账户了？' : '还没有账户？'}{' '}
              <Link
                to={isSignUp ? '/signin' : '/signup'}
                className="font-semibold text-brand-ink underline-offset-2 hover:underline"
              >
                {isSignUp ? '去登录' : '注册一个'}
              </Link>
            </p>
          </div>

          <p className="mt-6 text-center text-2xs text-ink-faint">
            继续即表示你同意 TagNest 的服务条款与隐私政策。
          </p>
        </div>
      </main>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Button, Input } from '@/components/ui';
import { useAuth } from '@/stores/auth';
import { HttpError } from '@/lib/api';

interface LocationState {
  from?: string;
}

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
    const from = (location.state as LocationState | null)?.from;
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
    <div className="flex min-h-dvh flex-col items-center justify-center bg-canvas px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-7 flex flex-col items-center gap-3 text-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-brand text-on-brand">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M7 4h10a1 1 0 0 1 1 1v14.4a.7.7 0 0 1-1.1.57L12 16.6l-4.9 3.37A.7.7 0 0 1 6 19.4V5a1 1 0 0 1 1-1Z"
                fill="currentColor"
              />
            </svg>
          </span>
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-ink">TagNest</h1>
            <p className="mt-1 text-sm text-ink-soft">
              {isSignUp ? '创建账户，开始整理你的书签' : '欢迎回来'}
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

          <Button
            type="submit"
            variant="primary"
            size="lg"
            fullWidth
            loading={submitting}
            className="mt-1"
          >
            {isSignUp ? '创建账户' : '登录'}
          </Button>
        </form>

        <p className="mt-4 text-center text-sm text-ink-soft">
          {isSignUp ? '已经有账户了？' : '还没有账户？'}{' '}
          <Link
            to={isSignUp ? '/signin' : '/signup'}
            className="font-medium text-brand-ink underline-offset-2 hover:underline"
          >
            {isSignUp ? '去登录' : '注册一个'}
          </Link>
        </p>
      </div>
    </div>
  );
}

import { useState } from 'react';
import { Coins, ShieldCheck } from 'lucide-react';
import type { PlanId, SubStatus } from '@shared/types';
import { Badge, Button, Input, Select, Skeleton, Switch } from '@/components/ui';
import { useBillingStatus, useGrantProTrial, useUpdateAiSettings } from '@/hooks/queries';
import { Card } from './Card';

const PLAN_LABEL: Record<PlanId, string> = {
  free: '免费版（自托管）',
  pro: 'Pro',
  team: 'Team',
  admin: '管理员',
};

const STATUS_META: Record<SubStatus, { label: string; tone: 'neutral' | 'brand' | 'positive' | 'caution' }> = {
  none: { label: '未订阅', tone: 'neutral' },
  trialing: { label: '试用中', tone: 'brand' },
  active: { label: '生效中', tone: 'positive' },
  canceled: { label: '已取消', tone: 'caution' },
};

const PLAN_OPTIONS = [
  { value: 'pro', label: 'Pro（200 额度）' },
  { value: 'team', label: 'Team（1000 额度）' },
];

/**
 * Phase A billing surface.
 *
 * Three cards, in order of how often a user touches them:
 *
 *   1. 套餐与额度 — plan badge + live credit meter. Rendered only when this
 *      instance actually serves a hosted model (`managedAvailable`); a plain
 *      self-hosted deploy gets a one-line note instead of meters it can't fill.
 *   2. 托管 AI 开关 — the consent toggle (`managedEnabled`). Explicit consent
 *      is what keeps "the site spent my credits" from becoming a support
 *      dispute; flipping it off is instant and survives reloads.
 *   3. 管理员发放试用 — operator tooling gated by the instance ADMIN_TOKEN.
 *      The token is typed per use and never stored.
 */
export function BillingSection() {
  const { data, isLoading, isError } = useBillingStatus();
  const update = useUpdateAiSettings();

  if (isLoading) {
    return (
      <Card title="用量与订阅">
        <Skeleton className="h-32 w-full" />
      </Card>
    );
  }

  if (isError || !data) {
    return (
      <Card title="用量与订阅">
        <p className="text-xs leading-relaxed text-ink-soft">
          暂时无法读取计费信息，请稍后重试。自托管实例未配置托管模型时，AI 功能继续使用你自己的 API Key。
        </p>
      </Card>
    );
  }

  const status = STATUS_META[data.status];
  const { balance, used, plan: allowance } = data.credits;

  return (
    <>
      <Card
        title="套餐与额度"
        description="1 额度 = 托管模型分析 1 条书签。使用自己的 API Key 时不消耗额度。"
      >
        {!data.managedAvailable ? (
          <p className="text-xs leading-relaxed text-ink-soft">
            此实例未配置托管模型，AI 整理完全使用你自己的 API Key，无额度概念。
          </p>
        ) : (
          <div className="flex flex-col gap-3.5">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="brand" dot>
                {PLAN_LABEL[data.plan]}
              </Badge>
              <Badge tone={status.tone}>{status.label}</Badge>
              {data.isTrial && <Badge tone="caution">试用期</Badge>}
            </div>

            <div className="flex items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3">
              <Coins size={18} className="shrink-0 text-brand" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-ink">
                  剩余额度 {balance}
                  {allowance > 0 && <span className="text-xs font-normal text-ink-soft"> / 本期 {allowance}</span>}
                </p>
                <p className="mt-0.5 text-2xs text-ink-soft">累计已使用 {used}</p>
              </div>
            </div>

            {balance === 0 && data.plan !== 'free' && (
              <p className="text-xs leading-relaxed text-caution-ink">
                额度已用完：托管模型将暂停，配置自己的 API Key 后可继续使用，或联系管理员补充额度。
              </p>
            )}
          </div>
        )}
      </Card>

      <Card title="托管 AI">
        <Switch
          checked={data.managedEnabled}
          onChange={(next) => update.mutate({ managedEnabled: next })}
          label="允许使用托管模型整理书签"
          hint="未配置自己的 API Key 且持有付费套餐时，由实例托管的模型完成整理并扣减额度。关闭后仅使用你自己的 Key。"
          disabled={!data.managedAvailable || update.isPending}
        />
      </Card>

      <AdminGrantCard />
    </>
  );
}

/** Operator-only: seed a trial subscription + credits for a user by email. */
function AdminGrantCard() {
  const grant = useGrantProTrial();
  const [email, setEmail] = useState('');
  const [token, setToken] = useState('');
  const [plan, setPlan] = useState<PlanId>('pro');
  const [credits, setCredits] = useState('');
  const [days, setDays] = useState('');

  const canSubmit = email.trim().length > 0 && token.trim().length > 0 && !grant.isPending;

  return (
    <Card
      title="管理员 · 发放试用"
      description="需要实例的 ADMIN_TOKEN（wrangler pages secret put ADMIN_TOKEN 配置）。未配置时接口返回 503。"
    >
      <div className="flex flex-col gap-3.5">
        <Input
          label="用户邮箱"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="user@example.com"
        />
        <Input
          label="管理员令牌"
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="ADMIN_TOKEN"
          hint="仅本次请求使用，不会保存。"
        />
        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-3">
          <Select
            label="套餐"
            value={plan}
            onChange={(e) => setPlan(e.target.value as PlanId)}
            options={PLAN_OPTIONS}
          />
          <Input
            label="额度（可选）"
            type="number"
            value={credits}
            onChange={(e) => setCredits(e.target.value)}
            placeholder="默认按套餐"
          />
          <Input
            label="试用天数（可选）"
            type="number"
            value={days}
            onChange={(e) => setDays(e.target.value)}
            placeholder="默认 14"
          />
        </div>
        <Button
          variant="primary"
          className="self-start"
          iconLeft={<ShieldCheck size={15} />}
          loading={grant.isPending}
          disabled={!canSubmit}
          onClick={() =>
            grant.mutate({
              token: token.trim(),
              email: email.trim(),
              plan,
              ...(credits.trim() ? { credits: Number(credits) } : {}),
              ...(days.trim() ? { days: Number(days) } : {}),
            })
          }
        >
          发放试用
        </Button>
        {grant.isSuccess && (
          <p className="text-xs leading-relaxed text-positive-ink">
            发放成功：{grant.data.email} → {PLAN_LABEL[grant.data.plan]}（+{grant.data.credits} 额度）。
          </p>
        )}
      </div>
    </Card>
  );
}

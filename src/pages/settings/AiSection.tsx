import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import type { AiProvider } from '@shared/types';
import { Button, Input, Select, Skeleton, Switch } from '@/components/ui';
import { useAiSettings, useUpdateAiSettings } from '@/hooks/queries';
import { aiReadiness } from '@/lib/ai-readiness';
import { Card } from './Card';

const PROVIDER_OPTIONS: { value: AiProvider; label: string }[] = [
  { value: 'none', label: '未选择' },
  { value: 'openai', label: 'OpenAI 兼容' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'gemini', label: 'Google Gemini' },
  { value: 'custom', label: '自定义端点' },
];

/**
 * The AI panel is wired end-to-end to storage but performs no inference.
 *
 * This is a deliberate product decision, not an oversight: the settings
 * persist, so switching the feature on later is a server-side change with no
 * migration. The banner says so plainly rather than letting users discover a
 * dead switch.
 */
export function AiSection() {
  const { data, isLoading } = useAiSettings();
  const update = useUpdateAiSettings();

  const [apiKey, setApiKey] = useState('');
  const [provider, setProvider] = useState<AiProvider | null>(null);
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);

  if (isLoading || !data) {
    return (
      <Card title="AI 助手">
        <Skeleton className="h-40 w-full" />
      </Card>
    );
  }

  const currentProvider = provider ?? data.provider;
  const currentBaseUrl = baseUrl ?? data.baseUrl ?? '';
  const currentModel = model ?? data.model ?? '';

  // Live readiness: mirrors the backend `loadAiConfig` gate, so the UI is honest
  // about whether saving a bookmark will actually run inference today.
  const missing = aiReadiness({
    provider: currentProvider,
    hasApiKey: data.hasApiKey,
    tempKeyPresent: Boolean(apiKey),
    model: currentModel,
    autoTag: data.autoTag,
    autoSummarize: data.autoSummarize,
  });
  const aiReady = missing.length === 0;

  return (
    <>
      {aiReady ? (
        <section className="mb-4 flex items-start gap-2.5 rounded-md border border-positive bg-positive-soft px-4 py-3">
          <Sparkles size={16} className="mt-px shrink-0 text-positive-ink" aria-hidden />
          <div>
            <p className="text-sm font-medium text-positive-ink">AI 已就绪</p>
            <p className="mt-1 text-xs leading-relaxed text-ink-soft">
              保存书签时会自动{' '}
              {[data.autoSummarize && '生成摘要', data.autoTag && '推荐标签'].filter(Boolean).join('、')}。
            </p>
          </div>
        </section>
      ) : (
        <section className="mb-4 flex items-start gap-2.5 rounded-md border border-caution bg-caution-soft px-4 py-3">
          <Sparkles size={16} className="mt-px shrink-0 text-caution-ink" aria-hidden />
          <div>
            <p className="text-sm font-medium text-caution-ink">AI 尚未生效，还差以下配置</p>
            <ul className="mt-1 list-inside list-disc text-xs leading-relaxed text-ink-soft">
              {missing.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          </div>
        </section>
      )}

      <Card title="模型配置">
        <div className="flex flex-col gap-3.5">
          <Select
            label="服务商"
            value={currentProvider}
            onChange={(e) => setProvider(e.target.value as AiProvider)}
            options={PROVIDER_OPTIONS}
          />

          <Input
            label="接口地址"
            value={currentBaseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.openai.com/v1"
            disabled={currentProvider === 'none'}
          />

          <Input
            label="模型名称"
            value={currentModel}
            onChange={(e) => setModel(e.target.value)}
            placeholder="gpt-4o-mini"
            disabled={currentProvider === 'none'}
          />

          <Input
            label="API Key"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={data.hasApiKey ? '已保存（留空则不修改）' : 'sk-…'}
            hint="加密存储在服务端，写入后不会再返回给浏览器。"
            disabled={currentProvider === 'none'}
          />

          <Button
            variant="primary"
            className="self-start"
            loading={update.isPending}
            onClick={() =>
              update.mutate({
                provider: currentProvider,
                baseUrl: currentBaseUrl || null,
                model: currentModel || null,
                ...(apiKey ? { apiKey } : {}),
              })
            }
          >
            保存配置
          </Button>
        </div>
      </Card>

      <Card title="自动化">
        <div className="flex flex-col gap-3">
          <Switch
            checked={data.autoSummarize}
            onChange={(next) => update.mutate({ autoSummarize: next })}
            label="自动生成摘要"
            hint="保存书签时生成一段内容摘要"
            disabled={currentProvider === 'none'}
          />
          <div className="h-px bg-line" />
          <Switch
            checked={data.autoTag}
            onChange={(next) => update.mutate({ autoTag: next })}
            label="自动推荐标签"
            hint="根据网页内容推荐 1–3 个标签"
            disabled={currentProvider === 'none'}
          />
        </div>
      </Card>
    </>
  );
}

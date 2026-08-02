import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
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

const MAX_TAGS_OPTIONS = [2, 3, 4, 5, 6].map((n) => ({ value: String(n), label: `${n} 个` }));

/**
 * AI configuration.
 *
 * ## What changed here and why it mattered
 *
 * This panel used to describe a feature that could not run. The banner said
 * "AI 已就绪" based on a readiness check that omitted the one column the
 * backend actually gated on (`enabled`), which nothing in the product ever set
 * to 1. Users saw a green light and got nothing.
 *
 * `enabled` is now derived server-side from exactly the fields checked here
 * (see `functions/_lib/ai/config.ts#isModelReady`), so the banner and the
 * behaviour cannot disagree. The panel also stopped being the whole feature:
 * running AI tagging lives on its own page now, and this screen only
 * configures it.
 */
export function AiSection() {
  const navigate = useNavigate();
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

  // Mirrors the server-side derivation exactly; an empty list means inference
  // will actually run.
  const missing = aiReadiness({
    provider: currentProvider,
    hasApiKey: data.hasApiKey,
    tempKeyPresent: Boolean(apiKey),
    model: currentModel,
    autoTag: data.autoTag,
    autoSummarize: data.autoSummarize,
  });
  const modelReady = missing.length === 0;

  return (
    <>
      {modelReady ? (
        <section className="mb-4 flex items-start gap-2.5 rounded-md border border-positive bg-positive-soft px-4 py-3">
          <Sparkles size={16} className="mt-px shrink-0 text-positive-ink" aria-hidden />
          <div className="min-w-0">
            <p className="text-sm font-medium text-positive-ink">模型已就绪</p>
            <p className="mt-1 text-xs leading-relaxed text-ink-soft">
              保存书签时会自动
              {[data.autoSummarize && '生成摘要', data.autoTag && '推荐标签']
                .filter(Boolean)
                .join('、')}
              ，推荐结果进入「AI 整理 → 确认」队列，确认后才会写入标签。
            </p>
          </div>
        </section>
      ) : (
        <section className="mb-4 flex items-start gap-2.5 rounded-md border border-caution bg-caution-soft px-4 py-3">
          <Sparkles size={16} className="mt-px shrink-0 text-caution-ink" aria-hidden />
          <div className="min-w-0">
            <p className="text-sm font-medium text-caution-ink">模型未接入，还差以下配置</p>
            <ul className="mt-1 list-inside list-disc text-xs leading-relaxed text-ink-soft">
              {missing.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
            {/* Without this line the warning reads as "the feature is dead",
                which is no longer true — the local engine covers this case. */}
            <p className="mt-1.5 text-xs leading-relaxed text-ink-soft">
              {data.heuristicsEnabled
                ? '本地规则引擎已开启，即使不配置模型也能生成标签建议，只是覆盖面更窄。'
                : '本地规则引擎也已关闭，当前无法生成任何标签建议。'}
            </p>
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
            hint={`保存书签时分析内容并推荐最多 ${data.maxTags} 个标签`}
            disabled={currentProvider === 'none'}
          />
        </div>
      </Card>

      <Card title="整理策略">
        <div className="flex flex-col gap-3">
          {/* The local engine is what keeps the feature usable with no key at
              all, so it gets a first-class switch rather than being hidden. */}
          <Switch
            checked={data.heuristicsEnabled}
            onChange={(next) => update.mutate({ heuristicsEnabled: next })}
            label="本地规则引擎"
            hint="无需 API Key，根据域名、路径和关键词生成标签建议；与模型结果互相印证可提高置信度"
          />

          <div className="h-px bg-line" />

          <Select
            label="每条书签最多推荐"
            value={String(data.maxTags)}
            onChange={(e) => update.mutate({ maxTags: Number(e.target.value) })}
            options={MAX_TAGS_OPTIONS}
            hint="标签太多会稀释检索价值，太少会漏掉维度，默认 4 个"
          />

          <div className="h-px bg-line" />

          <Select
            label="自动应用阈值"
            value={String(data.autoApplyThreshold)}
            onChange={(e) => update.mutate({ autoApplyThreshold: Number(e.target.value) })}
            options={[
              { value: '1', label: '始终人工确认（推荐）' },
              { value: '0.95', label: '置信度 ≥ 95% 自动应用' },
              { value: '0.85', label: '置信度 ≥ 85% 自动应用' },
              { value: '0.7', label: '置信度 ≥ 70% 自动应用' },
            ]}
            hint="低于阈值的建议仍然进入确认队列。建议先用一段时间人工确认，确认质量稳定后再调低。"
          />
        </div>
      </Card>

      <Card title="运行 AI 整理">
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 flex-1 text-xs leading-relaxed text-ink-soft">
            批量整理、确认建议、标签体系体检都在「AI 整理」页面进行。
          </p>
          <Button
            variant="secondary"
            iconLeft={<Sparkles size={15} />}
            onClick={() => navigate('/organize')}
          >
            打开 AI 整理
          </Button>
        </div>
      </Card>
    </>
  );
}

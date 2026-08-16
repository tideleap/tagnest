import { useState } from 'react';
import { CloudUpload, DatabaseBackup, Play, Trash2 } from 'lucide-react';
import type { BackupFrequency, BackupKind, BackupTarget, BackupTargetInput } from '@shared/types';
import { Badge, Button, Card, CardBody, CardHeader, Input, Select, Skeleton } from '@/components/ui';
import {
  useBackupRuns,
  useBackupTargets,
  useDeleteBackupTarget,
  useRunBackup,
  useUpsertBackupTarget,
} from '@/hooks/queries/backup';
import { relativeTime } from '@/lib/url';

type FormState = Partial<BackupTargetInput> & { id?: string };

const EMPTY_FORM: FormState = { kind: 'webdav', endpoint: '', frequency: 'daily' };

export function BackupSection() {
  const targets = useBackupTargets();
  const runs = useBackupRuns();
  const upsert = useUpsertBackupTarget();
  const del = useDeleteBackupTarget();
  const run = useRunBackup();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  const reset = () => setForm(EMPTY_FORM);
  const edit = (t: BackupTarget) =>
    setForm({
      id: t.id,
      kind: t.kind,
      endpoint: t.endpoint,
      bucket: t.bucket ?? '',
      username: t.username ?? '',
      remotePath: t.remotePath,
      enabled: t.enabled,
      frequency: t.frequency,
    });
  const save = () => {
    if (!form.endpoint) return;
    upsert.mutate(form as BackupTargetInput, { onSuccess: reset });
  };

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader
          title={
            <span className="inline-flex items-center gap-1.5">
              <DatabaseBackup size={14} aria-hidden />备份目标
            </span>
          }
          hint="书签库导出包将推送到你的自有存储，凭据加密保存"
        />
        <CardBody className="flex flex-col gap-4">
          {targets.isLoading ? (
            <Skeleton className="h-24" />
          ) : (
            <>
              {targets.data && targets.data.length > 0 && (
                <ul className="flex flex-col gap-2">
                  {targets.data.map((t) => (
                    <li
                      key={t.id}
                      className="flex items-center justify-between rounded-md border border-line bg-surface px-3 py-2"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 text-sm font-medium text-ink">
                          <Badge tone={t.kind === 's3' ? 'caution' : 'positive'}>{t.kind.toUpperCase()}</Badge>
                          <span className="truncate">{t.endpoint}</span>
                        </div>
                        <div className="mt-0.5 text-2xs text-ink-faint">
                          {t.frequency !== 'off' ? `每 ${t.frequency === 'daily' ? '天' : '周'}` : '手动'} ·{' '}
                          {t.lastStatus === 'ok'
                            ? '上次成功'
                            : t.lastStatus === 'failed'
                              ? '上次失败'
                              : '未运行'}
                        </div>
                      </div>
                      <div className="flex shrink-0 gap-1">
                        <Button size="sm" variant="ghost" onClick={() => run.mutate(undefined)} disabled={run.isPending}>
                          <Play size={14} aria-hidden />备份
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => edit(t)}>
                          编辑
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => del.mutate(t.id)}>
                          <Trash2 size={14} aria-hidden />
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="text-2xs text-ink-soft">
                  类型
                  <Select
                    value={form.kind}
                    onChange={(e) => setForm({ ...form, kind: e.target.value as BackupKind })}
                    options={[
                      { value: 'webdav', label: 'WebDAV' },
                      { value: 's3', label: 'S3' },
                    ]}
                  />
                </label>
                <label className="text-2xs text-ink-soft">
                  远程地址
                  <Input
                    value={form.endpoint ?? ''}
                    onChange={(e) => setForm({ ...form, endpoint: e.target.value })}
                    placeholder="https://dav.example.com/ 或 https://s3.region.amazonaws.com"
                  />
                </label>
                {form.kind === 's3' && (
                  <label className="text-2xs text-ink-soft">
                    Bucket
                    <Input
                      value={form.bucket ?? ''}
                      onChange={(e) => setForm({ ...form, bucket: e.target.value })}
                      placeholder="my-bucket"
                    />
                  </label>
                )}
                <label className="text-2xs text-ink-soft">
                  用户名 / Access Key
                  <Input
                    value={form.username ?? ''}
                    onChange={(e) => setForm({ ...form, username: e.target.value })}
                  />
                </label>
                <label className="text-2xs text-ink-soft">
                  密码 / Secret Key
                  <Input
                    type="password"
                    value={form.secret ?? ''}
                    onChange={(e) => setForm({ ...form, secret: e.target.value })}
                    placeholder={form.id ? '留空保持不变' : '必填'}
                  />
                </label>
                <label className="text-2xs text-ink-soft">
                  远程目录
                  <Input
                    value={form.remotePath ?? '/'}
                    onChange={(e) => setForm({ ...form, remotePath: e.target.value })}
                  />
                </label>
                <label className="text-2xs text-ink-soft">
                  频率
                  <Select
                    value={form.frequency}
                    onChange={(e) => setForm({ ...form, frequency: e.target.value as BackupFrequency })}
                    options={[
                      { value: 'off', label: '手动' },
                      { value: 'daily', label: '每日' },
                      { value: 'weekly', label: '每周' },
                    ]}
                  />
                </label>
              </div>

              <div className="flex gap-2">
                <Button onClick={save} disabled={upsert.isPending || !form.endpoint}>
                  <CloudUpload size={14} aria-hidden />
                  {form.id ? '保存修改' : '添加目标'}
                </Button>
                {form.id && (
                  <Button variant="ghost" onClick={reset}>
                    取消
                  </Button>
                )}
              </div>
            </>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title={
            <span className="inline-flex items-center gap-1.5">
              <Play size={14} aria-hidden />推送历史
            </span>
          }
          hint="每次备份的结果与字节数"
        />
        <CardBody>
          {runs.isLoading ? (
            <Skeleton className="h-16" />
          ) : runs.data && runs.data.length > 0 ? (
            <ul className="flex flex-col gap-1.5">
              {runs.data.map((r) => (
                <li key={r.id} className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2">
                    <Badge tone={r.status === 'ok' ? 'positive' : 'critical'}>
                      {r.status === 'ok' ? '成功' : '失败'}
                    </Badge>
                    <span className="text-ink-soft">
                      {r.kind.toUpperCase()} · {r.endpoint}
                    </span>
                  </span>
                  <span className="text-2xs text-ink-faint">
                    {relativeTime(r.startedAt)}
                    {r.bytes ? ` · ${(r.bytes / 1024).toFixed(1)} KB` : ''}
                    {r.error ? ` · ${r.error}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink-faint">还没有备份记录。</p>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

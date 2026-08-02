/* repro-import-local.mjs — end-to-end local reproduction of the import 503.
 *
 * Starts/expects `wrangler pages dev` on :8791 with a migrated local D1,
 * registers a throwaway user, POSTs a small but representative Chrome HTML
 * bookmark file to /api/import/preview, and prints the raw status + body.
 * Run inside ONE bash call so the dev server and this client share a network
 * namespace (the sandbox isolates background Bash calls).
 */
const BASE = process.env.BASE || 'http://127.0.0.1:8791';
const EMAIL = `repro_${Date.now()}@test.local`;
const PASSWORD = 'ReproPass123!';

const fetchish = async (path, { method = 'GET', headers = {}, body } = {}) => {
  const res = await fetch(BASE + path, { method, headers, body, redirect: 'manual' });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text };
};

const HTML = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
  <DT><H3>工具</H3>
  <DL><p>
    <DT><A HREF="https://example.com/a?utm_source=x">示例 A</A>
    <DT><A HREF="https://example.com/b?gclid=1">示例 B</A>
    <DT><A HREF="https://中文示例.cn/路径?fbclid=2">中文示例</A>
  </DL><p>
</DL><p>
`;

// multipart with the HTML as a "file" part
function multipart(fileName, content) {
  const boundary = '----reproboundary' + Date.now();
  const pre = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: text/html\r\n\r\n`;
  const post = `\r\n--${boundary}--\r\n`;
  const body = Buffer.concat([Buffer.from(pre, 'utf8'), Buffer.from(content, 'utf8'), Buffer.from(post, 'utf8')]);
  return { boundary, body };
}

const main = async () => {
  console.log('1) 注册', EMAIL);
  const reg = await fetchish('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  console.log('   register ->', reg.status);
  let accessToken = '';
  try { accessToken = JSON.parse(reg.body)?.accessToken || ''; } catch {}
  if (!accessToken) {
    console.log('   register body:', reg.body.slice(0, 300));
    process.exit(2);
  }
  const authHeader = { Authorization: `Bearer ${accessToken}` };

  console.log('2) 构造书签文件并上传 preview');
  const { boundary, body } = multipart('bookmarks_repro.html', HTML);
  const up = await fetchish('/api/import/preview', {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: body,
  });
  console.log('   preview ->', up.status);
  console.log('   body:', up.body.slice(0, 500));
};

main().catch((e) => console.error('REPRO ERROR', e));

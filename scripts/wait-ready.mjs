// wait-ready.mjs — poll a URL until it answers ok (used in-process with the dev server).
const url = process.argv[2] || 'http://127.0.0.1:8791/api/health';
const timeoutMs = Number(process.argv[3] || 25000);
(async () => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url, { redirect: 'manual' });
      if (r.ok && r.status < 500) {
        console.log(`ready after ${Date.now() - start}ms (${r.status})`);
        process.exit(0);
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  console.error(`not ready within ${timeoutMs}ms`);
  process.exit(1);
})();

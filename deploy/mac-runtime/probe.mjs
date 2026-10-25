// Bounded, read-only request executed by the app's actual Node helper.
const target = new URL(process.argv[2]);
if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('Invalid probe URL');
try {
  const response = await fetch(target, { signal: AbortSignal.timeout(5000), redirect: 'error' });
  const reader = response.body?.getReader();
  let bytes = 0;
  if (reader) {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 65536) { await reader.cancel(); break; }
    }
  }
  console.log(JSON.stringify({ ok: response.ok, status: response.status, bytes, node: process.version, pid: process.pid }));
  if (!response.ok) process.exitCode = 1;
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: error.name, cause: error.cause?.code ?? null, node: process.version }));
  process.exitCode = 1;
}

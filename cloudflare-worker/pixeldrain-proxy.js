
// Only these hosts may be proxied — keeps the worker from being abused as an open proxy.
const ALLOWED_HOSTS = /^(?:[a-z0-9-]+\.)*pixeldrain\.(?:com|net)$/i;

export default {
  async fetch(request) {
    const reqUrl = new URL(request.url);

    // A bare GET/HEAD with no ?url= is the launcher's liveness probe — answer OK so the
    // worker is considered "live" and selected from the pool.
    const target = reqUrl.searchParams.get('url');
    if (!target) {
      return new Response('Sail Launcher PixelDrain proxy is live.', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    let upstream;
    try {
      upstream = new URL(target);
    } catch {
      return new Response('Bad ?url= parameter.', { status: 400 });
    }
    if (!ALLOWED_HOSTS.test(upstream.hostname)) {
      return new Response('Only pixeldrain.com URLs may be proxied.', { status: 403 });
    }

    // Build the upstream request. Sending pixeldrain's own domain as Referer satisfies
    // its hotlink protection. Forward Range so aria2 can split / resume the download.
    const fwdHeaders = new Headers({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://pixeldrain.com/',
      'Accept': '*/*',
    });
    const range = request.headers.get('Range');
    if (range) fwdHeaders.set('Range', range);

    let resp;
    try {
      resp = await fetch(upstream.toString(), {
        method: request.method === 'HEAD' ? 'HEAD' : 'GET',
        headers: fwdHeaders,
        redirect: 'follow',
      });
    } catch (err) {
      return new Response('Upstream fetch failed: ' + err, { status: 502 });
    }

    // Pass the body straight through (streamed) with the headers a downloader needs.
    const outHeaders = new Headers();
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'content-disposition', 'last-modified', 'etag']) {
      const v = resp.headers.get(h);
      if (v) outHeaders.set(h, v);
    }
    if (!outHeaders.has('accept-ranges')) outHeaders.set('accept-ranges', 'bytes');
    outHeaders.set('access-control-allow-origin', '*');

    return new Response(request.method === 'HEAD' ? null : resp.body, {
      status: resp.status,
      statusText: resp.statusText,
      headers: outHeaders,
    });
  },
};

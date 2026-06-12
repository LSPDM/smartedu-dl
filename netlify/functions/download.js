/**
 * Vercel Serverless 函数 - 课件下载代理
 * 解决 CDN 的 CORS 问题：服务端请求不受 CORS 限制
 */
const https = require('https');

// 下载单个 URL
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 10000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        contentType: res.headers['content-type'] || '',
        body: Buffer.concat(chunks)
      }));
    }).on('error', reject);
  });
}

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // 只处理 POST
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  const { action, url: downloadUrl, activityId, token } = req.body || {};

  if (action === 'getResources') {
    // 获取资源列表
    const apiUrl = `https://s-file-2.ykt.cbern.com.cn/zxx/ndrv2/national_lesson/resources/details/${activityId}.json`;
    try {
      const result = await fetchUrl(apiUrl);
      const data = JSON.parse(result.body.toString());
      res.json({ ok: true, data });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
    return;
  }

  if (action === 'downloadPdf') {
    // 下载 PDF
    if (!token) return res.status(400).json({ error: 'token required' });
    try {
      const result = await fetchUrl(downloadUrl + '?accessToken=' + encodeURIComponent(token));
      if (result.status === 200 && result.body.length > 500) {
        res.setHeader('Content-Type', result.contentType);
        res.setHeader('Content-Length', result.body.length);
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.send(result.body);
      } else {
        res.status(502).json({ error: 'CDN returned ' + result.status });
      }
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
    return;
  }

  if (action === 'downloadImage') {
    // 下载图片
    try {
      const result = await fetchUrl(downloadUrl);
      if (result.status === 200 && result.body.length > 500) {
        res.setHeader('Content-Type', result.contentType);
        res.setHeader('Content-Length', result.body.length);
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.send(result.body);
      } else {
        res.status(502).json({ error: 'CDN ' + result.status });
      }
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
    return;
  }

  res.status(400).json({ error: 'invalid action' });
};

/**
 * 课件下载代理 - Netlify Serverless Function
 */
const https = require('https');

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 12000 }, (res) => {
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

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 200, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) };
  }

  let body;
  try { body = JSON.parse(event.body); } catch (e) {
    return { statusCode: 400, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'invalid json' }) };
  }

  const { action, url: downloadUrl, activityId, token } = body;

  if (action === 'getResources') {
    const apiUrl = `https://s-file-2.ykt.cbern.com.cn/zxx/ndrv2/national_lesson/resources/details/${activityId}.json`;
    try {
      const result = await fetchUrl(apiUrl);
      const data = JSON.parse(result.body.toString());
      return { statusCode: 200, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, data }) };
    } catch (e) {
      return { statusCode: 502, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: e.message }) };
    }
  }

  if (action === 'downloadPdf') {
    if (!token) return { statusCode: 400, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'token required' }) };
    try {
      const result = await fetchUrl(downloadUrl + '?accessToken=' + encodeURIComponent(token));
      if (result.status === 200 && result.body.length > 500) {
        return {
          statusCode: 200,
          headers: {
            ...headers,
            'Content-Type': result.contentType,
            'Content-Length': result.body.length,
            'Cache-Control': 'public, max-age=3600',
          },
          body: result.body.toString('base64'),
          isBase64Encoded: true,
        };
      }
      return { statusCode: 502, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'CDN ' + result.status, size: result.body.length }) };
    } catch (e) {
      return { statusCode: 502, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: e.message }) };
    }
  }

  if (action === 'downloadImage') {
    try {
      const result = await fetchUrl(downloadUrl);
      if (result.status === 200 && result.body.length > 500) {
        return {
          statusCode: 200,
          headers: {
            ...headers,
            'Content-Type': result.contentType,
            'Content-Length': result.body.length,
            'Cache-Control': 'public, max-age=86400',
          },
          body: result.body.toString('base64'),
          isBase64Encoded: true,
        };
      }
      return { statusCode: 502, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'CDN ' + result.status }) };
    } catch (e) {
      return { statusCode: 502, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: e.message }) };
    }
  }

  return { statusCode: 400, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'invalid action' }) };
};

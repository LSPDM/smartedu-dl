/**
 * 智慧中小学课件下载 - 后端
 * 纯 HTTP，无 Chromium 依赖，可部署到 Render/Railway
 */
const express = require('express');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3456;
const OUT = path.join(__dirname, 'output');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

// ============ SSE ============
const clients = new Set();
function broadcast(event, data) {
  const s = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const r of clients) r.write(s);
}

// ============ HTTP helper ============
function fetchUrl(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, { timeout }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, timeout).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ============ Express ============
const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.get('/api/progress', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' });
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

app.get('/api/ping', (req, res) => res.json({ ok: true }));

app.get('/api/list', (req, res) => {
  const result = [];
  if (!fs.existsSync(OUT)) return res.json([]);
  for (const dir of fs.readdirSync(OUT)) {
    const d = path.join(OUT, dir);
    if (!fs.statSync(d).isDirectory()) continue;
    const files = [];
    scan(d, dir, files);
    result.push({ course: dir, files });
  }
  res.json(result);
});

app.use('/files', express.static(OUT));

app.post('/api/download', async (req, res) => {
  const { url, token } = req.body;
  if (!url || !token) return res.status(400).json({ error: '缺少 URL 或 Token' });

  const m = url.match(/activityId=([a-f0-9-]+)/i);
  if (!m) return res.status(400).json({ error: 'URL 格式错误' });

  const activityId = m[1];
  res.json({ ok: true, activityId });

  try {
    broadcast('status', { msg: '获取课程信息...' });

    // Step 1: fetch resource API
    const apiUrl = `https://s-file-2.ykt.cbern.com.cn/zxx/ndrv2/national_lesson/resources/details/${activityId}.json`;
    const apiResp = await fetchUrl(apiUrl);
    if (apiResp.status !== 200) {
      broadcast('done', { error: '获取课程信息失败 HTTP ' + apiResp.status });
      return;
    }
    const data = JSON.parse(apiResp.body.toString());
    const title = data.global_title?.['zh-CN'] || data.title || '未命名';
    const items = data.relations?.national_course_resource || [];
    broadcast('status', { msg: `${title} · ${items.length} 个资源` });

    // Step 2: build download list
    const downloads = [];
    for (const item of items) {
      const cp = item.custom_properties || {};
      const keys = Object.keys(cp.preview || {});
      let folder = '', ts = '';
      if (keys.length > 0) {
        const mf = cp.preview[keys[0]].match(/edu_product\/esp\/([^/]+)\//);
        if (mf) folder = mf[1];
        const mt = cp.preview[keys[0]].match(/\/(\d{13})\//);
        if (mt) ts = mt[1];
      }
      if (item.resource_type_code === 'micro_lesson_video') continue;
      const label = ({ coursewares: '课件', lesson_plandesign: '教学设计', task_list: '学习任务单', class_exercises: '课后练习' })[folder] || folder;
      downloads.push({ label, folder, id: item.id, ts, isCW: folder === 'coursewares' });
    }

    const outDir = path.join(OUT, safe(title));
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const total = downloads.length;
    let done = 0, pdfCount = 0, imgCount = 0;

    // Step 3: download PDFs
    const priHosts = ['r1-ndr-private.ykt.cbern.com.cn', 'r2-ndr-private.ykt.cbern.com.cn', 'r3-ndr-private.ykt.cbern.com.cn'];

    for (const dl of downloads) {
      if (dl.isCW) continue;
      done++;
      broadcast('status', { msg: `下载 ${dl.label} PDF (${done}/${total})...` });

      let ok = false;
      for (const host of priHosts) {
        if (ok) break;
        const pdfUrl = `https://${host}/edu_product/esp/${dl.folder}/${dl.id}.t/zh-CN/${dl.ts}/transcode/pdf.pdf?accessToken=${encodeURIComponent(token)}`;
        try {
          const resp = await fetchUrl(pdfUrl, 20000);
          if (resp.status === 200 && resp.body.length > 1000) {
            const filepath = path.join(outDir, `${safe(dl.label)}_${safe(title)}.pdf`);
            fs.writeFileSync(filepath, resp.body);
            ok = true; pdfCount++;
            broadcast('status', { msg: `✅ ${dl.label} PDF (${(resp.body.length/1024).toFixed(0)}KB)` });
          }
        } catch (e) {}
      }
      if (!ok) broadcast('status', { msg: `❌ ${dl.label} 下载失败` });
    }

    // Step 4: download courseware images
    const cw = downloads.find(d => d.isCW);
    if (cw && cw.ts) {
      const imgDir = path.join(outDir, '课件_页面图片');
      if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });

      const pubHosts = ['r1-ndr.ykt.cbern.com.cn', 'r2-ndr.ykt.cbern.com.cn', 'r3-ndr.ykt.cbern.com.cn'];
      let miss = 0;
      for (let p = 1; p <= 60; p++) {
        if (miss >= 3 && p > 5) break;
        let ok = false;
        for (const host of pubHosts) {
          if (ok) break;
          try {
            const resp = await fetchUrl(`https://${host}/edu_product/esp/${cw.folder}/${cw.id}.t/zh-CN/${cw.ts}/transcode/image/${p}.jpg`, 8000);
            if (resp.status === 200 && resp.body.length > 500) {
              fs.writeFileSync(path.join(imgDir, `page_${String(p).padStart(3, '0')}.jpg`), resp.body);
              imgCount++; ok = true; miss = 0;
            }
          } catch (e) {}
        }
        if (!ok) miss++;
        if (imgCount % 5 === 0 && imgCount > 0) broadcast('status', { msg: `课件图片: ${imgCount} 张...` });
      }
      broadcast('status', { msg: `✅ 课件图片: ${imgCount} 张` });
    }

    // Done
    const resultFiles = [];
    scan(outDir, path.basename(outDir), resultFiles);
    broadcast('done', { ok: true, course: title, pdfCount, imgCount, files: resultFiles });

  } catch (e) {
    broadcast('done', { error: e.message });
  }
});

app.use(express.static(__dirname, { index: 'index.html' }));

app.listen(PORT, () => console.log(`✅ http://localhost:${PORT}`));

// ============ utils ============
function safe(s) { return (s || 'untitled').replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '_').substring(0, 60); }
function scan(base, prefix, out) {
  for (const f of fs.readdirSync(base)) {
    const p = path.join(base, f);
    if (fs.statSync(p).isDirectory()) scan(p, path.join(prefix, f), out);
    else out.push({ name: path.join(prefix, f), size: fs.statSync(p).size });
  }
}

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { ImageProcessor } from './image-processor.js';
import { Library } from './library.js';

const config = loadConfig();
await fsp.mkdir(config.uploadDir, { recursive: true });
await fsp.mkdir(config.imageDir, { recursive: true });
const db = openDatabase(config);
const library = new Library({ db, config, imageProcessor: new ImageProcessor(config) });
const app = Fastify({ logger: true, bodyLimit: 2 * 1024 * 1024 });

await app.register(multipart, { limits: { files: 1000, fileSize: 50 * 1024 * 1024, parts: 1100 } });
await app.register(fastifyStatic, { root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public'), wildcard: false });

app.setErrorHandler((error, _request, reply) => {
  const code = error.statusCode || 500;
  reply.code(code).send({ error: error.message, current: error.current });
});

app.get('/api/health', async () => ({ ok: true, provider: config.geminiKey ? 'gemini' : 'demo', time: new Date().toISOString() }));
app.get('/api/system/status', async () => systemStatus());

app.post('/api/photos/import', async (request, reply) => {
  const storage=await systemStatus();
  if(!storage.storageOk)return reply.code(507).send({error:'服务端存储空间不足，已停止接收新照片'});
  const imported = [];
  for await (const part of request.files()) {
    const tempPath = path.join(config.uploadDir, `${crypto.randomUUID()}.upload`);
    await pipeline(part.file, fs.createWriteStream(tempPath, { flags: 'wx' }));
    const stat = await fsp.stat(tempPath);
    try {
      imported.push(await library.importPhoto({
        tempPath, filename: safeFilename(part.filename), mimeType: part.mimetype,
        byteSize: stat.size, sourceKind: request.query?.source || 'web',
        sourceKey: request.headers['x-visionlog-source-key'] || null,
        timezone: request.headers['x-visionlog-timezone'] || null,
      }));
    } catch (error) { await fsp.rm(tempPath, { force: true }); throw error; }
  }
  if (!imported.length) return reply.code(400).send({ error: '请选择至少一张照片' });
  return reply.code(202).send({ imported });
});

app.get('/api/photos', async request => library.listPhotos(request.query));
app.post('/api/photos/batch', async request => library.batchPhotos(request.body));
app.get('/api/photos/:id', async (request, reply) => found(reply, library.getPhoto(request.params.id)));
app.patch('/api/photos/:id', async (request, reply) => found(reply, library.updatePhoto(request.params.id, request.body)));
app.post('/api/photos/:id/archive', async (request, reply) => found(reply, library.archivePhoto(request.params.id, request.body?.archived !== false)));
app.post('/api/photos/:id/trash', async (request, reply) => found(reply, library.trashPhoto(request.params.id)));
app.post('/api/photos/:id/restore', async (request, reply) => found(reply, library.restorePhoto(request.params.id)));
app.delete('/api/photos/:id', async (request, reply) => {
  const photo = library.getPhoto(request.params.id);
  if (!photo?.trashedAt) return reply.code(409).send({ error: '照片必须先进入回收站' });
  return { deleted: await library.purgePhoto(request.params.id) };
});
app.delete('/api/photos/:id/sources/:sourceId', async (request, reply) => found(reply,library.removePhotoSource(request.params.id,request.params.sourceId)));

app.get('/media/:id/:variant', async (request, reply) => {
  const asset = db.prepare('SELECT master_path,thumbnail_path FROM photo_assets WHERE id=?').get(request.params.id);
  if (!asset) return reply.code(404).send({ error: '图片不存在' });
  const target = request.params.variant === 'thumbnail' ? asset.thumbnail_path : asset.master_path;
  if (!target || !fs.existsSync(target)) return reply.code(404).send({ error: '图片尚未就绪' });
  reply.type('image/webp').header('cache-control', 'private, max-age=86400');
  return reply.send(fs.createReadStream(target));
});
app.get('/media-log/:id/thumbnail', async (request, reply) => {
  const asset = db.prepare('SELECT a.thumbnail_path FROM photo_assets a JOIN photo_logs l ON l.asset_id=a.id WHERE l.id=?').get(request.params.id);
  if (!asset?.thumbnail_path || !fs.existsSync(asset.thumbnail_path)) return reply.code(404).send({ error: '图片尚未就绪' });
  reply.type('image/webp').header('cache-control', 'private, max-age=86400');
  return reply.send(fs.createReadStream(asset.thumbnail_path));
});

app.get('/api/jobs', async () => library.listJobs());
app.post('/api/jobs/:id/retry', async request => { library.retryJob(request.params.id); return { queued: true }; });
app.post('/api/jobs/:id/cancel', async (request,reply) => found(reply,library.cancelJob(request.params.id)));

app.get('/api/topics', async () => library.listTopics());
app.get('/api/search', async request => library.search(request.query?.q));
app.post('/api/topics/:id/confirm', async (request, reply) => found(reply, library.confirmTopic(request.params.id, request.body)));
app.patch('/api/topics/:id', async (request,reply) => found(reply,library.updateTopic(request.params.id,request.body)));
app.delete('/api/topics/:id', async request => ({deleted:library.deleteTopic(request.params.id)}));
app.post('/api/topics/:id/merge', async (request,reply) => found(reply,library.mergeTopics(request.params.id,request.body?.sourceId)));

app.get('/api/plogs', async request => library.listPlogs(request.query));
app.post('/api/plogs/generate', async (request, reply) => reply.code(201).send(await library.generatePlog(request.body)));
app.get('/api/plogs/:id', async (request, reply) => found(reply, library.getPlog(request.params.id)));
app.patch('/api/plogs/:id', async (request, reply) => found(reply, library.updatePlog(request.params.id, request.body)));
app.post('/api/plogs/:id/regenerate', async (request, reply) => found(reply, await library.regeneratePlog(request.params.id)));
app.post('/api/plogs/:id/resolve-update', async (request, reply) => found(reply, library.resolvePlogUpdate(request.params.id, request.body?.accept === true)));
app.post('/api/plogs/:id/trash', async (request, reply) => found(reply, library.trashPlog(request.params.id)));
app.post('/api/plogs/:id/archive', async (request, reply) => found(reply, library.archivePlog(request.params.id,request.body?.archived!==false)));
app.post('/api/plogs/:id/restore', async (request, reply) => found(reply, library.restorePlog(request.params.id)));
app.delete('/api/plogs/:id', async request => ({ deleted: library.purgePlog(request.params.id) }));

app.get('/api/settings', async () => ({ ...library.getSettings(), provider: config.geminiKey ? 'gemini' : 'demo', model: config.geminiModel }));
app.patch('/api/settings', async request => library.updateSettings(request.body));
app.post('/api/library/clear', async request => library.clearAll(request.body?.phrase));
app.post('/api/library/reset-import-protection', async () => library.resetImportProtection());
app.post('/api/library/export', async (request, reply) => {
  const target = path.join(config.uploadDir, `visionlog-export-${Date.now()}-${crypto.randomUUID()}.tar.gz`);
  await library.exportTo(target, { includeDebug: request.body?.includeDebug === true });
  reply.raw.on('finish', () => fsp.rm(target, { force:true }));
  reply.header('content-type','application/gzip').header('content-disposition',`attachment; filename="visionlog-${new Date().toISOString().slice(0,10)}.tar.gz"`);
  return reply.send(fs.createReadStream(target));
});
app.post('/api/library/import', async (request, reply) => {
  let target;
  for await (const part of request.files({ limits:{ files:1, fileSize:10 * 1024 * 1024 * 1024 } })) {
    target = path.join(config.uploadDir, `${crypto.randomUUID()}.visionlog-import`);
    await pipeline(part.file, fs.createWriteStream(target,{flags:'wx'}));
  }
  if (!target) return reply.code(400).send({error:'请选择 VisionLog 导出包'});
  return library.importFrom(target);
});
app.post('/api/search/rebuild', async () => ({ rebuilt:true, strategy:'sqlite-source-query', photos:library.listPhotos({q:''}).length, plogs:library.listPlogs().length }));
app.post('/api/maintenance/run', async () => { await library.maintenance(); await runDailyPlog(); return { ok: true }; });

app.get('/*', async (_request, reply) => reply.sendFile('index.html'));

function safeFilename(value = 'photo') { return path.basename(value).replace(/[\u0000-\u001f]/g, '_').slice(0, 240); }
function found(reply, value) { return value == null ? reply.code(404).send({ error: '内容不存在' }) : value; }

async function systemStatus(){
  const stats=await fsp.statfs(config.dataDir);const freeBytes=Number(stats.bavail)*Number(stats.bsize);let overdueOriginals=0;
  for(const file of await fsp.readdir(config.uploadDir).catch(()=>[])){if(!file.endsWith('.upload'))continue;const stat=await fsp.stat(path.join(config.uploadDir,file)).catch(()=>null);if(stat&&Date.now()-stat.mtimeMs>86400000)overdueOriginals++;}
  const settings=library.getSettings();return{freeBytes,storageOk:freeBytes>=config.minFreeBytes,overdueOriginals,providerPaused:Boolean(config.geminiKey&&settings.provider_consent!=='true')};
}

async function runDailyPlog() {
  const settings = library.getSettings();
  const zone = settings.timezone || config.timezone;
  const yesterday = new Date(Date.now() - 86400000);
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(yesterday);
  const results=[];
  for (const missingDate of library.dailyDatesThrough(date)) try { results.push(await library.generatePlog({ date:missingDate, kind:'daily' })); }
  catch(error) { if(!error.message.includes('没有可用于')) app.log.error(error,'daily plog failed'); }
  return results;
}

await library.resumeQueuedJobs();
await library.maintenance();
setInterval(() => library.maintenance().catch(error => app.log.error(error)), 60 * 60 * 1000).unref();
setInterval(() => {
  const hour = Number(library.getSettings().plog_hour || 3);
  if (new Date().getHours() === hour) runDailyPlog();
}, 60 * 60 * 1000).unref();

await app.listen({ host: config.host, port: config.port });

for (const signal of ['SIGINT','SIGTERM']) process.on(signal, async () => { await app.close(); db.close(); process.exit(0); });

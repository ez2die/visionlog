import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { openDatabase } from '../src/db.js';
import { ImageProcessor } from '../src/image-processor.js';
import { Library, VersionConflictError } from '../src/library.js';

async function fixture(overrides = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'visionlog-test-'));
  const config = {
    dataDir, dbPath:path.join(dataDir,'db.sqlite'), uploadDir:path.join(dataDir,'uploads'), imageDir:path.join(dataDir,'images'),
    timezone:'Asia/Shanghai', plogHour:3, geminiKey:'', geminiModel:'test', geminiTier:'paid', geminiConsented:false, ...overrides,
  };
  await fs.mkdir(config.uploadDir, { recursive:true });
  const db = openDatabase(config); const library = new Library({ db, config, imageProcessor:new ImageProcessor(config) });
  return { dataDir, config, db, library, async photo(name='sunset.jpg', color='#a86445') {
    const tempPath = path.join(config.uploadDir, `${crypto.randomUUID()}.jpg`);
    await sharp({ create:{ width:2400,height:1600,channels:3,background:color } }).jpeg().toFile(tempPath);
    return { tempPath, filename:name, mimeType:'image/jpeg', byteSize:(await fs.stat(tempPath)).size, timezone:'Asia/Shanghai' };
  }, async close() { db.close(); await fs.rm(dataDir,{recursive:true,force:true}); } };
}

async function waitForJob(library, id, states = ['complete','needs_attention','waiting_provider']) {
  for (let i=0;i<100;i++) {
    const job = library.listJobs().find(item => item.id === id);
    if (states.includes(job?.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('job timeout');
}

test('import builds one compressed Photo Log and removes the original', async () => {
  const f = await fixture();
  try {
    const input = await f.photo(); const duplicatePath = path.join(f.config.uploadDir,'same.jpg'); await fs.copyFile(input.tempPath, duplicatePath);
    const result = await f.library.importPhoto(input);
    const job = await waitForJob(f.library, result.jobId); assert.equal(job.status,'complete');
    const photo = f.library.getPhoto(result.assetId);
    assert.equal(photo.status,'complete'); assert.equal(photo.effective.title,'sunset'); assert.equal(photo.width,2048);
    assert.equal((await sharp(path.join(f.config.imageDir,`${photo.id}.webp`)).metadata()).format,'webp');
    await assert.rejects(fs.access(input.tempPath));

    const duplicate = await f.library.importPhoto({ tempPath:duplicatePath,filename:'copy.jpg',mimeType:'image/jpeg',byteSize:(await fs.stat(duplicatePath)).size });
    assert.equal(duplicate.duplicate,true); assert.equal(duplicate.assetId,result.assetId);
  } finally { await f.close(); }
});

test('user override locks Photo Log and optimistic locking rejects stale edits', async () => {
  const f = await fixture();
  try {
    const imported = await f.library.importPhoto(await f.photo()); await waitForJob(f.library,imported.jobId);
    const original = f.library.getPhoto(imported.assetId);
    const updated = f.library.updatePhoto(imported.assetId,{version:original.version,overrides:{title:'我的黄昏',tags:['散步']}});
    assert.equal(updated.locked,true); assert.equal(updated.effective.title,'我的黄昏');
    assert.throws(() => f.library.updatePhoto(imported.assetId,{version:original.version,overrides:{title:'旧客户端'}}),VersionConflictError);
    const unlocked = f.library.updatePhoto(imported.assetId,{version:updated.version,action:'unlock'}); assert.equal(unlocked.locked,false); assert.equal(unlocked.effective.title,'我的黄昏');
  } finally { await f.close(); }
});

test('Plog retains member snapshot and paragraph fact references', async () => {
  const f = await fixture();
  try {
    const a = await f.library.importPhoto(await f.photo('one.jpg','#7b8d69')); const b = await f.library.importPhoto(await f.photo('two.jpg','#bc8b62'));
    await Promise.all([waitForJob(f.library,a.jobId),waitForJob(f.library,b.jobId)]);
    const plog = await f.library.generatePlog({photoLogIds:[a.photoLogId,b.photoLogId],kind:'manual'});
    assert.equal(plog.members.length,2); assert.equal(plog.status,'draft');
    assert.ok(plog.body.every(part => part.photoLogIds.length && part.factFields.length));
    const same = await f.library.generatePlog({photoLogIds:[b.photoLogId,a.photoLogId],kind:'manual'}); assert.equal(same.id,plog.id);
  } finally { await f.close(); }
});

test('archive visibility and 30-day trash restore preserve overrides', async () => {
  const f = await fixture();
  try {
    const imported = await f.library.importPhoto(await f.photo()); await waitForJob(f.library,imported.jobId);
    let photo = f.library.getPhoto(imported.assetId); photo = f.library.updatePhoto(photo.id,{version:photo.version,overrides:{note:'保留'}});
    f.library.archivePhoto(photo.id,true); assert.equal(f.library.listPhotos().length,0); assert.equal(f.library.listPhotos({q:'保留'}).length,1);
    f.library.archivePhoto(photo.id,false); f.library.trashPhoto(photo.id); assert.equal(f.library.listPhotos().length,0); assert.equal(f.library.listPhotos({trash:'true'}).length,1);
    const restored = f.library.restorePhoto(photo.id); assert.equal(restored.effective.note,'保留'); assert.equal(restored.trashedAt,null);
  } finally { await f.close(); }
});

test('configured provider without consent pauses recognition but preserves metadata Photo Log', async () => {
  const f = await fixture({geminiKey:'not-sent-because-no-consent'});
  try {
    const imported = await f.library.importPhoto(await f.photo()); const job = await waitForJob(f.library,imported.jobId);
    assert.equal(job.status,'waiting_provider'); const photo = f.library.getPhoto(imported.assetId);
    assert.equal(photo.status,'waiting_recognition'); assert.equal(photo.width,2048); assert.ok(photo.facts.originalName);
  } finally { await f.close(); }
});

test('complete export round-trips into a blank instance with images and references', async () => {
  const source=await fixture(), target=await fixture();
  try {
    const imported=await source.library.importPhoto(await source.photo()); await waitForJob(source.library,imported.jobId);
    const photo=source.library.getPhoto(imported.assetId); source.library.updatePhoto(photo.id,{version:photo.version,overrides:{title:'可迁移标题'}});
    await source.library.generatePlog({photoLogIds:[imported.photoLogId],kind:'manual'});
    const packagePath=path.join(source.config.uploadDir,'export.tar.gz'); await source.library.exportTo(packagePath,{includeDebug:false});
    const incoming=path.join(target.config.uploadDir,'incoming.tar.gz'); await fs.copyFile(packagePath,incoming);
    const result=await target.library.importFrom(incoming); assert.equal(result.imported.photo_assets,1); assert.equal(result.imported.plogs,1);
    const restored=target.library.listPhotos()[0]; assert.equal(restored.effective.title,'可迁移标题');
    assert.equal((await sharp(path.join(target.config.imageDir,`${restored.id}.webp`)).metadata()).format,'webp');
    assert.equal(target.library.listPlogs()[0].members[0],restored.photoLogId);
  } finally { await source.close(); await target.close(); }
});

test('clear all adds source protection so background sync cannot immediately restore content', async () => {
  const f=await fixture();
  try {
    const input=await f.photo(); const imported=await f.library.importPhoto({...input,sourceKind:'android',sourceKey:'external_primary:42'}); await waitForJob(f.library,imported.jobId);
    const cleared=f.library.clearAll('清空我的 VisionLog'); assert.equal(cleared.photos,1);
    await f.library.purgePhoto(imported.assetId);
    const retry=await f.photo('again.jpg'); const ignored=await f.library.importPhoto({...retry,sourceKind:'android',sourceKey:'external_primary:42'});
    assert.equal(ignored.ignored,true); assert.equal(f.library.listPhotos().length,0);
    assert.equal(f.library.resetImportProtection().removed,1);
  } finally { await f.close(); }
});

test('Photo Log edits create a reviewable Plog candidate instead of overwriting current version', async () => {
  const f=await fixture();
  try {
    const imported=await f.library.importPhoto(await f.photo());await waitForJob(f.library,imported.jobId);
    let plog=await f.library.generatePlog({photoLogIds:[imported.photoLogId],kind:'manual'});const oldTitle=plog.title;
    const photo=f.library.getPhoto(imported.assetId);f.library.updatePhoto(photo.id,{version:photo.version,overrides:{title:'新版事实',summary:'已经修正'}});
    plog=f.library.getPlog(plog.id);assert.equal(plog.updateAvailable,true);assert.equal(plog.title,oldTitle);
    plog=await f.library.regeneratePlog(plog.id);assert.equal(plog.currentVersion,1);assert.equal(plog.pendingVersion.version,2);
    plog=f.library.resolvePlogUpdate(plog.id,true);assert.equal(plog.currentVersion,2);assert.equal(plog.pendingVersion,null);assert.equal(plog.updateAvailable,false);
  } finally {await f.close();}
});

test('exact duplicate keeps multiple device sources and supports removing only one source', async () => {
  const f=await fixture();
  try {
    const input=await f.photo(),copy=path.join(f.config.uploadDir,'device-two.jpg');await fs.copyFile(input.tempPath,copy);
    const first=await f.library.importPhoto({...input,sourceKind:'android',sourceKey:'primary:1'});await waitForJob(f.library,first.jobId);
    const second=await f.library.importPhoto({tempPath:copy,filename:'same.jpg',mimeType:'image/jpeg',byteSize:(await fs.stat(copy)).size,sourceKind:'android',sourceKey:'sd:9'});
    assert.equal(second.duplicate,true);let photo=f.library.getPhoto(first.assetId);assert.equal(photo.sources.length,2);
    photo=f.library.removePhotoSource(first.assetId,photo.sources[0].id);assert.equal(photo.sources.length,1);assert.equal(f.library.listPhotos().length,1);
  } finally {await f.close();}
});

test('batch actions add a confirmed topic and archive selected photos', async () => {
  const f=await fixture();
  try {
    const imported=await f.library.importPhoto(await f.photo());await waitForJob(f.library,imported.jobId);
    assert.equal(f.library.batchPhotos({ids:[imported.assetId],action:'add_topic',topicName:'周末散步'}).changed,1);
    assert.equal(f.library.search('周末').topics[0].name,'周末散步');
    f.library.batchPhotos({ids:[imported.assetId],action:'archive'});assert.equal(f.library.listPhotos().length,0);
  } finally {await f.close();}
});

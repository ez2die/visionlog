import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';
import tar from 'tar-stream';

const entityTables = [
  'photo_assets', 'metadata_records', 'photo_logs', 'recognition_results',
  'topics', 'topic_photos', 'plogs', 'plog_versions',
];
const safeSettings = new Set(['timezone','plog_hour','sensitive_blur','provider_tier']);

export class DataTransfer {
  constructor(db, config) { this.db = db; this.config = config; }

  async exportTo(targetPath, { includeDebug = false } = {}) {
    const entities = {};
    for (const table of entityTables) entities[table] = this.db.prepare(`SELECT * FROM ${table}`).all();
    if (!includeDebug) entities.recognition_results = entities.recognition_results.map(row => ({ ...row, raw_json:null }));
    const files = [];
    for (const asset of entities.photo_assets) {
      for (const [variant, filePath] of [['master',asset.master_path],['thumbnail',asset.thumbnail_path]]) {
        if (!filePath || !fs.existsSync(filePath)) continue;
        const entry = `images/${asset.id}.${variant}.webp`;
        files.push({ entry, assetId:asset.id, variant, sha256:await hashFile(filePath), size:(await fsp.stat(filePath)).size, sourcePath:filePath });
      }
      asset.master_path = asset.master_path ? `images/${asset.id}.master.webp` : null;
      asset.thumbnail_path = asset.thumbnail_path ? `images/${asset.id}.thumbnail.webp` : null;
      asset.source_key = null;
    }
    const settings = Object.fromEntries(this.db.prepare('SELECT key,value FROM settings').all().filter(row => safeSettings.has(row.key)).map(row => [row.key,row.value]));
    const manifest = { schemaVersion:1, exportedAt:new Date().toISOString(), includeDebug, settings, entities,
      files:files.map(({sourcePath,...file}) => file), counts:Object.fromEntries(entityTables.map(table => [table,entities[table].length])) };

    await fsp.mkdir(path.dirname(targetPath), { recursive:true });
    const pack = tar.pack(); const completion = pipeline(pack, createGzip({level:6}), fs.createWriteStream(targetPath,{flags:'wx'}));
    await addBuffer(pack, 'manifest.json', Buffer.from(JSON.stringify(manifest)));
    for (const file of files) await pipeline(fs.createReadStream(file.sourcePath), pack.entry({ name:file.entry, size:file.size, mode:0o600 }));
    pack.finalize(); await completion; return { path:targetPath, counts:manifest.counts };
  }

  async importFrom(packagePath) {
    const occupied = this.db.prepare(`SELECT (SELECT count(*) FROM photo_assets)+(SELECT count(*) FROM plogs)+(SELECT count(*) FROM topics) count`).get().count;
    if (occupied) throw Object.assign(new Error('只能导入到空白实例'), { statusCode:409 });
    const tempDir = await fsp.mkdtemp(path.join(this.config.uploadDir,'import-'));
    try {
      await extractPackage(packagePath,tempDir);
      const manifest = JSON.parse(await fsp.readFile(path.join(tempDir,'manifest.json'),'utf8'));
      validateManifest(manifest);
      for (const file of manifest.files) {
        const local = safeJoin(tempDir,file.entry);
        if ((await hashFile(local)) !== file.sha256) throw new Error(`导出包文件校验失败：${file.entry}`);
      }
      await fsp.mkdir(this.config.imageDir,{recursive:true});
      const copied = [];
      try {
        for (const file of manifest.files) {
          const target = path.join(this.config.imageDir,`${file.assetId}${file.variant === 'thumbnail' ? '.thumb' : ''}.webp`);
          await fsp.copyFile(safeJoin(tempDir,file.entry),target); copied.push(target);
        }
        const tx = this.db.transaction(() => {
          const entities = manifest.entities;
          for (const row of entities.photo_assets) {
            row.master_path = row.master_path ? path.join(this.config.imageDir,`${row.id}.webp`) : null;
            row.thumbnail_path = row.thumbnail_path ? path.join(this.config.imageDir,`${row.id}.thumb.webp`) : null;
            row.source_kind = 'import'; row.source_key = null;
          }
          for (const table of entityTables) for (const row of entities[table]) insertRow(this.db,table,row);
          for (const [key,value] of Object.entries(manifest.settings || {})) if (safeSettings.has(key)) {
            this.db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(key,String(value),new Date().toISOString());
          }
        }); tx();
      } catch (error) { for (const file of copied) await fsp.rm(file,{force:true}); throw error; }
      return { imported:manifest.counts, exportedAt:manifest.exportedAt };
    } finally { await fsp.rm(tempDir,{recursive:true,force:true}); await fsp.rm(packagePath,{force:true}); }
  }
}

function insertRow(db, table, row) {
  const allowed=new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(column=>column.name));
  const columns = Object.keys(row); if(columns.some(column=>!allowed.has(column)))throw new Error(`导出包 ${table} 包含未知字段`);
  const placeholders = columns.map(() => '?').join(',');
  db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${placeholders})`).run(...columns.map(column => row[column]));
}

function addBuffer(pack,name,buffer) { return new Promise((resolve,reject) => pack.entry({name,size:buffer.length,mode:0o600},buffer,error => error ? reject(error) : resolve())); }
async function hashFile(file) { const hash=crypto.createHash('sha256'); for await (const chunk of fs.createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }
function safeJoin(root,entry) { const target=path.resolve(root,entry); if (!target.startsWith(path.resolve(root)+path.sep)) throw new Error('导出包包含非法路径'); return target; }

async function extractPackage(packagePath,tempDir) {
  const extract=tar.extract();
  const done=new Promise((resolve,reject) => {
    extract.on('entry',(header,stream,next) => {
      try {
        if (header.type !== 'file' || (header.name !== 'manifest.json' && !header.name.startsWith('images/'))) throw new Error('导出包包含未知条目');
        if(header.name==='manifest.json'&&header.size>50*1024*1024)throw new Error('导出包 manifest 过大');
        if(header.name.startsWith('images/')&&header.size>200*1024*1024)throw new Error('导出包图片条目过大');
        const target=safeJoin(tempDir,header.name);
        fsp.mkdir(path.dirname(target),{recursive:true}).then(() => pipeline(stream,fs.createWriteStream(target,{flags:'wx'}))).then(next,reject);
      } catch(error) { reject(error); }
    });
    extract.on('finish',resolve); extract.on('error',reject);
  });
  await pipeline(fs.createReadStream(packagePath),createGunzip(),extract); await done;
}

function validateManifest(manifest) {
  if (manifest?.schemaVersion !== 1 || !manifest.entities || !Array.isArray(manifest.files)) throw new Error('不支持或损坏的 VisionLog 导出包');
  for (const table of entityTables) {
    if (!Array.isArray(manifest.entities[table])) throw new Error(`导出包缺少 ${table}`);
    if (manifest.counts?.[table] !== manifest.entities[table].length) throw new Error(`导出包 ${table} 数量不一致`);
  }
  const assets=new Set(manifest.entities.photo_assets.map(row => row.id));
  if (manifest.entities.photo_logs.some(row => !assets.has(row.asset_id))) throw new Error('Photo Log 引用了不存在的资产');
  const logs=new Set(manifest.entities.photo_logs.map(row => row.id));
  if (manifest.entities.topic_photos.some(row => !logs.has(row.photo_log_id))) throw new Error('主题引用了不存在的 Photo Log');
}

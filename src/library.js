import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { json, getSettings, setSetting } from './db.js';
import { createProvider } from './provider.js';
import { DataTransfer } from './data-transfer.js';

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
const plusDays = (iso, days) => new Date(new Date(iso).getTime() + days * 86400000).toISOString();

export class VersionConflictError extends Error {
  constructor(current) { super('内容已在其他设备更新'); this.statusCode = 409; this.current = current; }
}

export class Library {
  constructor({ db, config, imageProcessor }) {
    this.db = db; this.config = config; this.imageProcessor = imageProcessor;
    this.dataTransfer = new DataTransfer(db, config);
    this.processing = new Set();
  }

  async importPhoto({ tempPath, filename, mimeType, byteSize, sourceKind = 'web', sourceKey = null, timezone }) {
    if (sourceKey && this.db.prepare('SELECT 1 FROM ignored_sources WHERE source_kind=? AND source_key=?').get(sourceKind, sourceKey)) {
      await fs.rm(tempPath, { force: true });
      return { ignored: true, reason: 'source_was_permanently_deleted' };
    }
    const bytes = await fs.readFile(tempPath);
    const contentHash = crypto.createHash('sha256').update(bytes).digest('hex');
    const duplicate = this.db.prepare('SELECT id,trashed_at FROM photo_assets WHERE content_hash=?').get(contentHash);
    if (duplicate) {
      if (sourceKey && !duplicate.trashed_at) this.db.prepare(`INSERT OR IGNORE INTO photo_sources(id,asset_id,source_kind,source_key,created_at) VALUES(?,?,?,?,?)`)
        .run(uid(), duplicate.id, sourceKind, sourceKey, now());
      await fs.rm(tempPath, { force: true });
      return { assetId: duplicate.id, duplicate: true, trashed: Boolean(duplicate.trashed_at) };
    }
    const assetId = uid(), logId = uid(), jobId = uid(), createdAt = now();
    const tz = timezone || getSettings(this.db).timezone || this.config.timezone;
    const transaction = this.db.transaction(() => {
      this.db.prepare(`INSERT INTO photo_assets(id,content_hash,original_name,mime_type,byte_size,status,source_kind,source_key,discovered_timezone,created_at,updated_at)
        VALUES(?,?,?,?,?,'processing',?,?,?,?,?)`).run(assetId, contentHash, filename, mimeType, byteSize, sourceKind, sourceKey, tz, createdAt, createdAt);
      this.db.prepare(`INSERT INTO photo_logs(id,asset_id,status,created_at,updated_at) VALUES(?,?,'processing',?,?)`)
        .run(logId, assetId, createdAt, createdAt);
      if (sourceKey) this.db.prepare(`INSERT INTO photo_sources(id,asset_id,source_kind,source_key,created_at) VALUES(?,?,?,?,?)`)
        .run(uid(), assetId, sourceKind, sourceKey, createdAt);
      this.db.prepare(`INSERT INTO processing_jobs(id,asset_id,kind,status,step,priority,payload_json,created_at,updated_at)
        VALUES(?,?,'ingest','queued','validate',10,?,?,?)`).run(jobId, assetId, JSON.stringify({ tempPath }), createdAt, createdAt);
    });
    transaction();
    setImmediate(() => this.processJob(jobId).catch(error => console.error('job failed', jobId, error)));
    return { assetId, photoLogId: logId, jobId, duplicate: false };
  }

  async processJob(jobId) {
    if (this.processing.has(jobId)) return;
    this.processing.add(jobId);
    const job = this.db.prepare('SELECT * FROM processing_jobs WHERE id=?').get(jobId);
    if (!job || !['queued','needs_attention','waiting_provider'].includes(job.status)) { this.processing.delete(jobId); return; }
    const asset = this.db.prepare('SELECT * FROM photo_assets WHERE id=?').get(job.asset_id);
    const log = this.db.prepare('SELECT * FROM photo_logs WHERE asset_id=?').get(job.asset_id);
    const payload = json(job.payload_json);
    try {
      this.updateJob(jobId, 'running', 'compress', null, job.attempts + 1);
      let factsRow = this.db.prepare('SELECT * FROM metadata_records WHERE asset_id=?').get(asset.id);
      if (!asset.master_path) {
        const result = await this.imageProcessor.process(payload.tempPath, asset.mime_type, asset.id, asset.original_name, asset.created_at);
        const dateTaken = result.facts.exifDateTaken || asset.created_at;
        const basis = result.facts.exifDateTaken ? 'exif_date_taken' : 'first_discovered';
        const tx = this.db.transaction(() => {
          this.db.prepare(`UPDATE photo_assets SET width=?,height=?,master_path=?,thumbnail_path=?,status='recognizing',updated_at=? WHERE id=?`)
            .run(result.width, result.height, result.masterPath, result.thumbnailPath, now(), asset.id);
          this.db.prepare(`INSERT OR REPLACE INTO metadata_records(asset_id,facts_json,date_taken,date_basis,latitude,longitude,camera) VALUES(?,?,?,?,?,?,?)`)
            .run(asset.id, JSON.stringify(result.facts), dateTaken, basis, result.facts.latitude, result.facts.longitude,
              [result.facts.make, result.facts.model].filter(Boolean).join(' ') || null);
          this.db.prepare(`UPDATE photo_logs SET status='recognizing',updated_at=? WHERE id=?`).run(now(), log.id);
        }); tx();
        await fs.rm(payload.tempPath, { force: true });
        factsRow = this.db.prepare('SELECT * FROM metadata_records WHERE asset_id=?').get(asset.id);
      }
      const currentAsset = this.db.prepare('SELECT * FROM photo_assets WHERE id=?').get(asset.id);
      if (currentAsset.trashed_at) throw Object.assign(new Error('照片已删除，处理已取消'), { code: 'CANCELLED' });
      this.updateJob(jobId, 'running', 'recognize');
      const settings = getSettings(this.db);
      const provider = createProvider(this.config, settings);
      const result = await provider.recognize({
        imagePath: currentAsset.master_path, mimeType: 'image/webp', originalName: asset.original_name,
        facts: json(factsRow.facts_json),
      });
      if(this.db.prepare('SELECT status FROM processing_jobs WHERE id=?').get(jobId)?.status==='cancelled')throw Object.assign(new Error('任务已由用户取消'),{code:'CANCELLED'});
      const completedAt = now();
      const tx = this.db.transaction(() => {
        const latestLog = this.db.prepare('SELECT locked FROM photo_logs WHERE id=?').get(log.id);
        if (!latestLog.locked) this.db.prepare(`UPDATE photo_logs SET status='complete',model_json=?,provider=?,model_id=?,schema_version='1',prompt_version='1',version=version+1,updated_at=? WHERE id=?`)
          .run(JSON.stringify(result.structured), result.provider, result.modelId, completedAt, log.id);
        this.db.prepare(`INSERT INTO recognition_results(id,photo_log_id,structured_json,raw_json,provider,model_id,created_at,raw_expires_at)
          VALUES(?,?,?,?,?,?,?,?)`).run(uid(), log.id, JSON.stringify(result.structured), JSON.stringify(result.raw), result.provider, result.modelId, completedAt, plusDays(completedAt, 30));
        this.db.prepare(`UPDATE photo_assets SET status='complete',updated_at=? WHERE id=?`).run(completedAt, asset.id);
        this.db.prepare(`UPDATE processing_jobs SET status='complete',step='complete',error=NULL,updated_at=? WHERE id=?`).run(completedAt, jobId);
      }); tx();
      this.recordTopicCandidates(log.id, result.structured.candidateTopics);
    } catch (error) {
      const cancelled = error.code === 'CANCELLED';
      const waiting = error.code === 'PROVIDER_CONSENT_REQUIRED';
      const retrying = error.code === 'PROVIDER_TEMPORARY' && job.attempts + 1 < 5;
      const status = cancelled ? 'cancelled' : waiting ? 'waiting_provider' : retrying ? 'queued' : 'needs_attention';
      const logStatus = cancelled ? 'cancelled' : 'waiting_recognition';
      this.db.prepare('UPDATE processing_jobs SET status=?,step=?,error=?,updated_at=? WHERE id=?')
        .run(status, waiting ? 'recognize' : status, String(error.message).slice(0, 1000), now(), jobId);
      this.db.prepare('UPDATE photo_logs SET status=?,updated_at=? WHERE id=?').run(logStatus, now(), log.id);
      this.db.prepare(`UPDATE photo_assets SET status=?,updated_at=? WHERE id=?`).run(logStatus, now(), asset.id);
      if(retrying)setTimeout(()=>this.processJob(jobId).catch(()=>{}),Math.min(60_000,1000*2**job.attempts)).unref();
    } finally { this.processing.delete(jobId); }
  }

  updateJob(id, status, step, error = null, attempts = null) {
    if (attempts == null) this.db.prepare('UPDATE processing_jobs SET status=?,step=?,error=?,updated_at=? WHERE id=?').run(status, step, error, now(), id);
    else this.db.prepare('UPDATE processing_jobs SET status=?,step=?,error=?,attempts=?,updated_at=? WHERE id=?').run(status, step, error, attempts, now(), id);
  }

  recordTopicCandidates(logId, candidates = []) {
    for (const candidate of candidates) {
      const name = candidate.name.trim(); if (!name) continue;
      let topic = this.db.prepare('SELECT * FROM topics WHERE name=? COLLATE NOCASE').get(name);
      if (!topic) {
        const id = uid(), t = now();
        this.db.prepare(`INSERT INTO topics(id,name,status,auto_created,created_at,updated_at) VALUES(?,?,'candidate',0,?,?)`).run(id, name, t, t);
        topic = { id, status: 'candidate' };
      }
      if(topic.status==='archived')continue;
      this.db.prepare(`INSERT OR REPLACE INTO topic_photos(topic_id,photo_log_id,confidence,confirmed) VALUES(?,?,?,0)`)
        .run(topic.id, logId, confidenceNumber(candidate.confidence));
      const count = this.db.prepare(`SELECT count(*) count FROM topic_photos WHERE topic_id=? AND confidence>=0.8`).get(topic.id).count;
      if (count >= 2 && candidate.confidence === 'high') this.db.prepare(`UPDATE topics SET status='active',auto_created=1,updated_at=? WHERE id=?`).run(now(), topic.id);
      if (count >= 2 && candidate.confidence === 'high') {
        const ids = this.db.prepare('SELECT photo_log_id FROM topic_photos WHERE topic_id=?').all(topic.id).map(row => row.photo_log_id);
        setImmediate(() => this.generatePlog({ photoLogIds:ids, kind:'topic', topicId:topic.id }).catch(() => {}));
      }
    }
  }

  listPhotos(filters = {}) {
    const where = [], args = [];
    if (filters.trash === 'true') where.push('a.trashed_at IS NOT NULL'); else where.push('a.trashed_at IS NULL');
    if (filters.archived === 'true') where.push('a.archived_at IS NOT NULL');
    else if (!filters.q) where.push('a.archived_at IS NULL');
    if (filters.status) { where.push('l.status=?'); args.push(filters.status); }
    if(filters.dateFrom){where.push('COALESCE(m.date_taken,a.created_at)>=?');args.push(filters.dateFrom);}
    if(filters.dateTo){where.push('COALESCE(m.date_taken,a.created_at)<?');args.push(`${filters.dateTo}T23:59:59.999Z`);}
    if(filters.mime){where.push('a.mime_type=?');args.push(filters.mime);}
    if(filters.tag){where.push('(l.model_json LIKE ? OR l.overrides_json LIKE ?)');args.push(`%${filters.tag}%`,`%${filters.tag}%`);}
    if(filters.location){where.push('(l.model_json LIKE ? OR l.overrides_json LIKE ?)');args.push(`%${filters.location}%`,`%${filters.location}%`);}
    if(filters.topicId){where.push('EXISTS(SELECT 1 FROM topic_photos tf WHERE tf.photo_log_id=l.id AND tf.topic_id=?)');args.push(filters.topicId);}
    if (filters.q) { where.push(`(a.original_name LIKE ? OR l.model_json LIKE ? OR l.overrides_json LIKE ?)`); args.push(...Array(3).fill(`%${filters.q}%`)); }
    const rows = this.db.prepare(`SELECT a.*,l.id photo_log_id,l.status log_status,l.model_json,l.overrides_json,l.locked,l.version,
      m.facts_json,m.date_taken,m.date_basis,m.latitude,m.longitude,m.camera
      FROM photo_assets a JOIN photo_logs l ON l.asset_id=a.id LEFT JOIN metadata_records m ON m.asset_id=a.id
      WHERE ${where.join(' AND ')} ORDER BY COALESCE(m.date_taken,a.created_at) DESC LIMIT 500`).all(...args);
    return rows.map(row => this.hydratePhoto(row));
  }

  getPhoto(id) {
    const row = this.db.prepare(`SELECT a.*,l.id photo_log_id,l.status log_status,l.model_json,l.overrides_json,l.locked,l.version,
      l.provider,l.model_id,l.schema_version,l.prompt_version,m.facts_json,m.date_taken,m.date_basis,m.latitude,m.longitude,m.camera
      FROM photo_assets a JOIN photo_logs l ON l.asset_id=a.id LEFT JOIN metadata_records m ON m.asset_id=a.id
      WHERE a.id=?`).get(id);
    if (!row) return null;
    const photo = this.hydratePhoto(row);
    photo.topics = this.db.prepare(`SELECT t.id,t.name,t.status,tp.confirmed,tp.confidence FROM topics t JOIN topic_photos tp ON tp.topic_id=t.id WHERE tp.photo_log_id=?`).all(row.photo_log_id);
    photo.sources = this.db.prepare(`SELECT id,source_kind,source_key,created_at FROM photo_sources WHERE asset_id=? ORDER BY created_at`).all(id);
    photo.plogs = this.db.prepare(`SELECT p.id,p.status,pv.title FROM plogs p JOIN plog_versions pv ON pv.plog_id=p.id AND pv.version=p.current_version WHERE pv.member_ids_json LIKE ? AND p.trashed_at IS NULL`).all(`%${row.photo_log_id}%`);
    return photo;
  }

  hydratePhoto(row) {
    const model = json(row.model_json), overrides = json(row.overrides_json), facts = json(row.facts_json);
    const effective = { ...model, ...Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined)) };
    return {
      id: row.id, photoLogId: row.photo_log_id, name: row.original_name, status: row.log_status,
      width: row.width, height: row.height, createdAt: row.created_at, updatedAt: row.updated_at,
      dateTaken: overrides.dateTaken || row.date_taken, dateBasis: overrides.dateTaken ? 'user' : row.date_basis,
      timezone: row.discovered_timezone, latitude: row.latitude, longitude: row.longitude, camera: row.camera,
      model, overrides, effective, facts, locked: Boolean(row.locked), version: row.version,
      sensitive: effective.sensitive || 'unknown', archived: Boolean(row.archived_at), trashedAt: row.trashed_at,
      imageUrl: `/media/${row.id}/master`, thumbnailUrl: `/media/${row.id}/thumbnail`,
      provider: row.provider, modelId: row.model_id,
    };
  }

  updatePhoto(id, { version, overrides, action }) {
    const photo = this.getPhoto(id); if (!photo) return null;
    if (Number(version) !== photo.version) throw new VersionConflictError(photo);
    let nextOverrides = overrides ?? photo.overrides, locked = 1;
    if (action === 'unlock') locked = 0;
    if (action === 'restore_model') { nextOverrides = {}; locked = 0; }
    const t = now();
    this.db.prepare('UPDATE photo_logs SET overrides_json=?,locked=?,version=version+1,updated_at=? WHERE asset_id=? AND version=?')
      .run(JSON.stringify(nextOverrides), locked, t, id, version);
    this.audit('photo', id, action || 'edit', { fields: Object.keys(nextOverrides) });
    this.markPlogsForPhoto(photo.photoLogId);
    return this.getPhoto(id);
  }

  archivePhoto(id, archived) {
    this.db.prepare('UPDATE photo_assets SET archived_at=?,updated_at=? WHERE id=?').run(archived ? now() : null, now(), id);
    this.audit('photo', id, archived ? 'archive' : 'unarchive'); return this.getPhoto(id);
  }

  trashPhoto(id) {
    const t = now();
    this.db.prepare('UPDATE photo_assets SET trashed_at=?,trash_expires_at=?,status=?,updated_at=? WHERE id=?')
      .run(t, plusDays(t, 30), 'trashed', t, id);
    this.db.prepare(`UPDATE processing_jobs SET status='cancelled',step='cancelled',updated_at=? WHERE asset_id=? AND status NOT IN ('complete','cancelled')`).run(t, id);
    this.audit('photo', id, 'trash'); return this.getPhoto(id);
  }

  restorePhoto(id) {
    this.db.prepare(`UPDATE photo_assets SET trashed_at=NULL,trash_expires_at=NULL,status='complete',updated_at=? WHERE id=?`).run(now(), id);
    this.audit('photo', id, 'restore'); return this.getPhoto(id);
  }

  async purgePhoto(id) {
    const asset = this.db.prepare('SELECT * FROM photo_assets WHERE id=?').get(id); if (!asset) return false;
    const sources = this.db.prepare('SELECT source_kind,source_key FROM photo_sources WHERE asset_id=?').all(id);
    if (asset.master_path) await fs.rm(asset.master_path, { force: true });
    if (asset.thumbnail_path) await fs.rm(asset.thumbnail_path, { force: true });
    const tx = this.db.transaction(() => {
      for (const source of sources) this.db.prepare('INSERT OR REPLACE INTO ignored_sources(source_kind,source_key,ignored_at) VALUES(?,?,?)').run(source.source_kind, source.source_key, now());
      this.db.prepare('DELETE FROM photo_assets WHERE id=?').run(id);
    }); tx();
    this.audit('photo', id, 'purge'); return true;
  }

  removePhotoSource(assetId,sourceId) {
    const source=this.db.prepare('SELECT * FROM photo_sources WHERE id=? AND asset_id=?').get(sourceId,assetId);if(!source)return null;
    const count=this.db.prepare('SELECT count(*) count FROM photo_sources WHERE asset_id=?').get(assetId).count;
    if(count<=1)throw Object.assign(new Error('这是唯一来源，请选择删除整张照片记录'),{statusCode:409});
    const tx=this.db.transaction(()=>{this.db.prepare('DELETE FROM photo_sources WHERE id=?').run(sourceId);this.db.prepare('INSERT OR REPLACE INTO ignored_sources(source_kind,source_key,ignored_at) VALUES(?,?,?)').run(source.source_kind,source.source_key,now());});tx();
    this.audit('photo_source',sourceId,'remove',{assetId});return this.getPhoto(assetId);
  }

  listJobs() { return this.db.prepare('SELECT id,asset_id,kind,status,step,attempts,error,created_at,updated_at FROM processing_jobs ORDER BY created_at DESC LIMIT 100').all(); }
  retryJob(id) { this.db.prepare(`UPDATE processing_jobs SET status='queued',error=NULL,updated_at=? WHERE id=?`).run(now(), id); setImmediate(() => this.processJob(id)); }
  cancelJob(id) {
    const job=this.db.prepare('SELECT * FROM processing_jobs WHERE id=?').get(id);if(!job)return null;const t=now();
    this.db.prepare(`UPDATE processing_jobs SET status='cancelled',step='cancelled',updated_at=? WHERE id=?`).run(t,id);
    if(job.asset_id){this.db.prepare(`UPDATE photo_logs SET status='cancelled',updated_at=? WHERE asset_id=?`).run(t,job.asset_id);this.db.prepare(`UPDATE photo_assets SET status='cancelled',updated_at=? WHERE id=?`).run(t,job.asset_id);}
    return this.db.prepare('SELECT * FROM processing_jobs WHERE id=?').get(id);
  }

  batchPhotos({ ids, action, topicName }) {
    if(!Array.isArray(ids)||!ids.length)throw Object.assign(new Error('请选择照片'),{statusCode:400});
    let changed=0,skipped=0;
    if(action==='archive'||action==='trash')for(const id of ids){action==='archive'?this.archivePhoto(id,true):this.trashPhoto(id);changed++;}
    else if(action==='add_topic'){
      const name=String(topicName||'').trim();if(!name)throw Object.assign(new Error('请输入主题名称'),{statusCode:400});let topic=this.db.prepare('SELECT id FROM topics WHERE name=? COLLATE NOCASE').get(name);if(!topic){topic={id:uid()};const t=now();this.db.prepare(`INSERT INTO topics(id,name,status,auto_created,created_at,updated_at) VALUES(?,?,'active',0,?,?)`).run(topic.id,name,t,t);}
      const insert=this.db.prepare('INSERT OR REPLACE INTO topic_photos(topic_id,photo_log_id,confidence,confirmed) VALUES(?,?,1,1)');for(const id of ids){const log=this.db.prepare('SELECT id FROM photo_logs WHERE asset_id=?').get(id);if(log){insert.run(topic.id,log.id);this.markPlogsForPhoto(log.id);changed++;}}
    } else if(action==='re_recognize'){
      for(const id of ids){const log=this.db.prepare('SELECT locked FROM photo_logs WHERE asset_id=?').get(id);if(!log||log.locked){skipped++;continue;}const jobId=uid(),t=now();this.db.prepare(`INSERT INTO processing_jobs(id,asset_id,kind,status,step,priority,payload_json,created_at,updated_at) VALUES(?,?,'re_recognize','queued','recognize',20,'{}',?,?)`).run(jobId,id,t,t);setImmediate(()=>this.processJob(jobId));changed++;}
    } else throw Object.assign(new Error('不支持的批量操作'),{statusCode:400});
    return{changed,skipped};
  }

  listTopics() {
    return this.db.prepare(`SELECT t.*,count(tp.photo_log_id) photo_count,group_concat(tp.photo_log_id) photo_log_ids FROM topics t LEFT JOIN topic_photos tp ON tp.topic_id=t.id GROUP BY t.id ORDER BY t.status,t.name`).all()
      .map(topic => ({ ...topic, photoLogIds: topic.photo_log_ids ? topic.photo_log_ids.split(',') : [] }));
  }
  search(query) {
    const q=String(query||'').trim();if(!q)return{photos:[],topics:[],plogs:[]};
    return{photos:this.listPhotos({q}),topics:this.db.prepare(`SELECT t.id,t.name,t.status,count(tp.photo_log_id) photo_count FROM topics t LEFT JOIN topic_photos tp ON tp.topic_id=t.id WHERE t.name LIKE ? GROUP BY t.id ORDER BY t.name LIMIT 50`).all(`%${q}%`),
      plogs:this.db.prepare(`SELECT p.id,p.status,pv.title,pv.opening,pv.member_ids_json FROM plogs p JOIN plog_versions pv ON pv.plog_id=p.id AND pv.version=p.current_version WHERE p.trashed_at IS NULL AND (pv.title LIKE ? OR pv.opening LIKE ?) ORDER BY p.created_at DESC LIMIT 50`).all(`%${q}%`,`%${q}%`).map(row=>({...row,members:json(row.member_ids_json,[])}))};
  }
  confirmTopic(id, { name, photoLogIds }) {
    const t = now();
    const tx = this.db.transaction(() => {
      this.db.prepare(`UPDATE topics SET name=?,status='active',updated_at=? WHERE id=?`).run(name, t, id);
      this.db.prepare('DELETE FROM topic_photos WHERE topic_id=?').run(id);
      const insert = this.db.prepare('INSERT INTO topic_photos(topic_id,photo_log_id,confidence,confirmed) VALUES(?,?,1,1)');
      for (const logId of photoLogIds) insert.run(id, logId);
    }); tx();
    for (const logId of photoLogIds) this.markPlogsForPhoto(logId);
    return this.listTopics().find(topic => topic.id === id);
  }

  updateTopic(id,{name,archived}) {
    const topic=this.db.prepare('SELECT * FROM topics WHERE id=?').get(id);if(!topic)return null;
    this.db.prepare('UPDATE topics SET name=?,status=?,updated_at=? WHERE id=?').run(String(name||topic.name).trim(),archived===true?'archived':archived===false?'active':topic.status,now(),id);return this.listTopics().find(item=>item.id===id);
  }
  deleteTopic(id){const topic=this.db.prepare('SELECT id FROM topics WHERE id=?').get(id);if(!topic)return false;this.db.prepare('DELETE FROM topics WHERE id=?').run(id);this.audit('topic',id,'delete');return true;}
  mergeTopics(targetId,sourceId){if(targetId===sourceId)throw Object.assign(new Error('请选择不同主题'),{statusCode:400});const tx=this.db.transaction(()=>{this.db.prepare(`INSERT OR IGNORE INTO topic_photos(topic_id,photo_log_id,confidence,confirmed) SELECT ?,photo_log_id,confidence,confirmed FROM topic_photos WHERE topic_id=?`).run(targetId,sourceId);this.db.prepare('DELETE FROM topics WHERE id=?').run(sourceId);this.db.prepare('UPDATE topics SET updated_at=? WHERE id=?').run(now(),targetId);});tx();return this.listTopics().find(item=>item.id===targetId);}

  async generatePlog({ photoLogIds, date, kind = 'manual', topicId = null }) {
    const topicName=topicId?this.db.prepare('SELECT name FROM topics WHERE id=?').get(topicId)?.name:null;
    let logs;
    if (photoLogIds?.length) {
      const placeholders = photoLogIds.map(() => '?').join(',');
      logs = this.db.prepare(`SELECT a.*,l.id photo_log_id,l.model_json,l.overrides_json,m.date_taken,m.facts_json
        FROM photo_logs l JOIN photo_assets a ON a.id=l.asset_id LEFT JOIN metadata_records m ON m.asset_id=a.id
        WHERE l.id IN (${placeholders}) AND a.trashed_at IS NULL`).all(...photoLogIds);
    } else if (date) {
      logs = this.db.prepare(`SELECT a.*,l.id photo_log_id,l.model_json,l.overrides_json,m.date_taken,m.facts_json
        FROM photo_logs l JOIN photo_assets a ON a.id=l.asset_id LEFT JOIN metadata_records m ON m.asset_id=a.id
        WHERE a.trashed_at IS NULL AND a.archived_at IS NULL AND l.status!='cancelled'`).all().filter(row => dateInZone(row.date_taken || row.created_at, row.discovered_timezone || this.config.timezone) === date);
    } else throw new Error('请选择照片或日期');
    if (!logs.length) throw new Error('没有可用于生成 Plog 的照片');
    const normalized = logs.map(row => {
      const value = { ...json(row.model_json), ...json(row.overrides_json) };
      return { id: row.photo_log_id, title: value.title || row.original_name, summary: value.summary || '尚未识别', description: value.description || '', scene: value.scene || 'unknown', tags: value.tags || [], dateTaken: row.date_taken };
    });
    const key = crypto.createHash('sha256').update(JSON.stringify({ kind, date, topicId, topicName, ids: normalized.map(x => x.id).sort(), language: 'zh-CN', prompt: '1' })).digest('hex');
    const existing = this.db.prepare('SELECT id FROM plogs WHERE idempotency_key=?').get(key);
    if (existing) return this.getPlog(existing.id);
    const provider = createProvider(this.config, getSettings(this.db));
    const composed = await provider.composePlog({ logs: normalized, dateLabel: date });
    const id = uid(), t = now();
    const body = (composed.paragraphs || []).map(p => ({ text: p.text, photoLogIds: p.photoLogIds, factFields: p.factFields }));
    const tx = this.db.transaction(() => {
      this.db.prepare(`INSERT INTO plogs(id,kind,rule_json,idempotency_key,status,created_at,updated_at) VALUES(?,?,?,?, 'draft',?,?)`)
        .run(id, kind, JSON.stringify({ date, topicId, topicName, photoLogIds: normalized.map(x => x.id) }), key, t, t);
      this.db.prepare(`INSERT INTO plog_versions(plog_id,version,title,opening,body_json,member_ids_json,cover_photo_log_id,incomplete,created_at)
        VALUES(?,1,?,?,?,?,?,?,?)`).run(id, composed.title, composed.opening, JSON.stringify(body), JSON.stringify(normalized.map(x => x.id)), composed.coverPhotoLogId, normalized.some(x => x.scene === 'unknown') ? 1 : 0, t);
    }); tx();
    return this.getPlog(id);
  }

  dailyDatesThrough(endDate) {
    const rows=this.db.prepare(`SELECT COALESCE(m.date_taken,a.created_at) date_value,a.discovered_timezone FROM photo_assets a JOIN photo_logs l ON l.asset_id=a.id LEFT JOIN metadata_records m ON m.asset_id=a.id WHERE a.trashed_at IS NULL AND a.archived_at IS NULL AND l.status!='cancelled'`).all();
    return [...new Set(rows.map(row => dateInZone(row.date_value,row.discovered_timezone||this.config.timezone)).filter(date => date && date<=endDate))].sort();
  }

  markPlogsForPhoto(photoLogId) {
    this.db.prepare(`UPDATE plogs SET update_available=1,updated_at=? WHERE trashed_at IS NULL AND EXISTS(SELECT 1 FROM plog_versions pv WHERE pv.plog_id=plogs.id AND pv.version=plogs.current_version AND pv.member_ids_json LIKE ?)`)
      .run(now(),`%\"${photoLogId}\"%`);
  }

  listPlogs({ trash = false, archived = false } = {}) {
    return this.db.prepare(`SELECT p.*,pv.title,pv.opening,pv.cover_photo_log_id,pv.incomplete,pv.member_ids_json
      FROM plogs p JOIN plog_versions pv ON pv.plog_id=p.id AND pv.version=p.current_version
      WHERE p.trashed_at IS ${trash ? 'NOT ' : ''}NULL AND p.archived_at IS ${archived ? 'NOT ' : ''}NULL ORDER BY p.created_at DESC LIMIT 200`).all().map(row => ({
        id: row.id, kind: row.kind, status: row.status, title: row.title, opening: row.opening,
        coverPhotoLogId: row.cover_photo_log_id, incomplete: Boolean(row.incomplete), members: json(row.member_ids_json, []),
        createdAt: row.created_at, feedback: row.feedback, trashedAt: row.trashed_at, updateAvailable:Boolean(row.update_available),
      }));
  }

  getPlog(id) {
    const row = this.db.prepare(`SELECT p.*,pv.title,pv.opening,pv.body_json,pv.member_ids_json,pv.cover_photo_log_id,pv.incomplete
      FROM plogs p JOIN plog_versions pv ON pv.plog_id=p.id AND pv.version=p.current_version WHERE p.id=?`).get(id);
    if (!row) return null;
    const members = json(row.member_ids_json, []);
    const foundPhotos = members.length ? this.db.prepare(`SELECT a.id,l.id photo_log_id,a.thumbnail_path,a.trashed_at FROM photo_logs l JOIN photo_assets a ON a.id=l.asset_id WHERE l.id IN (${members.map(() => '?').join(',')})`).all(...members) : [];
    const byMember=new Map(foundPhotos.map(x=>[x.photo_log_id,x]));
    const photos=members.map(photoLogId=>{const x=byMember.get(photoLogId);return x?{id:x.id,photoLogId,thumbnailUrl:`/media/${x.id}/thumbnail`,deleted:Boolean(x.trashed_at),permanent:false}:{id:null,photoLogId,thumbnailUrl:null,deleted:true,permanent:true};});
    const pending=row.pending_version ? this.db.prepare('SELECT version,title,opening,body_json,cover_photo_log_id,incomplete FROM plog_versions WHERE plog_id=? AND version=?').get(id,row.pending_version) : null;
    return { id: row.id, kind: row.kind, status: row.status, title: row.title, opening: row.opening, body: json(row.body_json, []), members, photos, coverPhotoLogId: row.cover_photo_log_id, incomplete: Boolean(row.incomplete), currentVersion: row.current_version, pendingVersion:pending ? {...pending,body:json(pending.body_json,[])} : null, updateAvailable:Boolean(row.update_available), feedback: row.feedback, feedbackNote: row.feedback_note, createdAt: row.created_at };
  }

  updatePlog(id, data) {
    const current = this.getPlog(id); if (!current) return null;
    const title = data.title ?? current.title, opening = data.opening ?? current.opening;
    const body = data.body ? data.body.map((item, i) => ({ ...current.body[i], text: item.text ?? current.body[i]?.text })) : current.body;
    this.db.prepare(`UPDATE plog_versions SET title=?,opening=?,body_json=?,cover_photo_log_id=? WHERE plog_id=? AND version=?`)
      .run(title, opening, JSON.stringify(body), data.coverPhotoLogId ?? current.coverPhotoLogId, id, current.currentVersion);
    if (data.status) this.db.prepare('UPDATE plogs SET status=?,updated_at=? WHERE id=?').run(data.status, now(), id);
    if (data.feedback) this.db.prepare('UPDATE plogs SET feedback=?,feedback_note=?,updated_at=? WHERE id=?').run(data.feedback, data.feedbackNote || null, now(), id);
    return this.getPlog(id);
  }

  async regeneratePlog(id) {
    const current=this.getPlog(id); if(!current)return null;
    const ids=current.members, placeholders=ids.map(()=>'?').join(',');
    const rows=ids.length ? this.db.prepare(`SELECT a.*,l.id photo_log_id,l.model_json,l.overrides_json,m.date_taken FROM photo_logs l JOIN photo_assets a ON a.id=l.asset_id LEFT JOIN metadata_records m ON m.asset_id=a.id WHERE l.id IN (${placeholders})`).all(...ids) : [];
    const normalized=rows.map(row=>{const value={...json(row.model_json),...json(row.overrides_json)};return{id:row.photo_log_id,title:value.title||row.original_name,summary:value.summary||'尚未识别',description:value.description||'',scene:value.scene||'unknown',tags:value.tags||[],dateTaken:row.date_taken};});
    if(!normalized.length)throw new Error('Plog 已没有可用成员照片');
    const rule=json(this.db.prepare('SELECT rule_json FROM plogs WHERE id=?').get(id).rule_json);
    const provider=createProvider(this.config,getSettings(this.db)); const composed=await provider.composePlog({logs:normalized,dateLabel:rule.date});
    const next=current.currentVersion+1,t=now(),body=(composed.paragraphs||[]).map(p=>({text:p.text,photoLogIds:p.photoLogIds,factFields:p.factFields}));
    const tx=this.db.transaction(()=>{
      this.db.prepare('DELETE FROM plog_versions WHERE plog_id=? AND version>?').run(id,current.currentVersion);
      this.db.prepare(`INSERT INTO plog_versions(plog_id,version,title,opening,body_json,member_ids_json,cover_photo_log_id,incomplete,created_at) VALUES(?,?,?,?,?,?,?,?,?)`)
        .run(id,next,composed.title,composed.opening,JSON.stringify(body),JSON.stringify(ids),composed.coverPhotoLogId,normalized.some(x=>x.scene==='unknown')?1:0,t);
      this.db.prepare('UPDATE plogs SET pending_version=?,update_available=1,updated_at=? WHERE id=?').run(next,t,id);
    });tx(); return this.getPlog(id);
  }

  resolvePlogUpdate(id,accept) {
    const plog=this.getPlog(id); if(!plog?.pendingVersion)return plog;
    const tx=this.db.transaction(()=>{
      if(accept){this.db.prepare('UPDATE plogs SET current_version=pending_version,pending_version=NULL,update_available=0,updated_at=? WHERE id=?').run(now(),id);this.db.prepare('DELETE FROM plog_versions WHERE plog_id=? AND version<?').run(id,Math.max(1,plog.pendingVersion.version-1));}
      else {this.db.prepare('DELETE FROM plog_versions WHERE plog_id=? AND version=?').run(id,plog.pendingVersion.version);this.db.prepare('UPDATE plogs SET pending_version=NULL,update_available=0,updated_at=? WHERE id=?').run(now(),id);}
    });tx(); return this.getPlog(id);
  }

  trashPlog(id) { const t = now(); this.db.prepare('UPDATE plogs SET trashed_at=?,trash_expires_at=?,updated_at=? WHERE id=?').run(t, plusDays(t, 30), t, id); return this.getPlog(id); }
  archivePlog(id,archived=true){this.db.prepare('UPDATE plogs SET archived_at=?,updated_at=? WHERE id=?').run(archived?now():null,now(),id);return this.getPlog(id);}
  restorePlog(id) { this.db.prepare('UPDATE plogs SET trashed_at=NULL,trash_expires_at=NULL,updated_at=? WHERE id=?').run(now(), id); return this.getPlog(id); }
  purgePlog(id) { return this.db.prepare('DELETE FROM plogs WHERE id=?').run(id).changes > 0; }

  getSettings() { return getSettings(this.db); }
  updateSettings(values) { for (const [key, value] of Object.entries(values)) setSetting(this.db, key, value); return getSettings(this.db); }

  clearAll(phrase) {
    if (phrase !== '清空我的 VisionLog') throw Object.assign(new Error('确认短语不正确'), { statusCode: 400 });
    const t = now(), expiry = plusDays(t, 30);
    const tx = this.db.transaction(() => {
      this.db.prepare(`INSERT OR IGNORE INTO ignored_sources(source_kind,source_key,ignored_at) SELECT source_kind,source_key,? FROM photo_sources`).run(t);
      this.db.prepare(`UPDATE photo_assets SET trashed_at=?,trash_expires_at=?,status='trashed',updated_at=? WHERE trashed_at IS NULL`).run(t, expiry, t);
      this.db.prepare(`UPDATE plogs SET trashed_at=?,trash_expires_at=?,updated_at=? WHERE trashed_at IS NULL`).run(t, expiry, t);
      this.db.prepare(`UPDATE processing_jobs SET status='cancelled',step='cancelled',updated_at=? WHERE status NOT IN ('complete','cancelled')`).run(t);
    }); tx();
    this.audit('library', 'self', 'clear_all');
    return { photos: this.db.prepare('SELECT count(*) count FROM photo_assets WHERE trashed_at IS NOT NULL').get().count,
      plogs: this.db.prepare('SELECT count(*) count FROM plogs WHERE trashed_at IS NOT NULL').get().count };
  }

  resetImportProtection() {
    const removed = this.db.prepare('DELETE FROM ignored_sources').run().changes;
    this.audit('library', 'self', 'reset_import_protection', { removed }); return { removed };
  }

  exportTo(targetPath, options) { return this.dataTransfer.exportTo(targetPath, options); }
  importFrom(packagePath) { return this.dataTransfer.importFrom(packagePath); }

  async maintenance() {
    const expiredAssets = this.db.prepare('SELECT id FROM photo_assets WHERE trash_expires_at IS NOT NULL AND trash_expires_at<=?').all(now());
    for (const row of expiredAssets) await this.purgePhoto(row.id);
    this.db.prepare('DELETE FROM plogs WHERE trash_expires_at IS NOT NULL AND trash_expires_at<=?').run(now());
    this.db.prepare('UPDATE recognition_results SET raw_json=NULL WHERE raw_expires_at<=?').run(now());
    const uploadFiles = await fs.readdir(this.config.uploadDir).catch(() => []);
    const cutoff = Date.now() - 86400000;
    for (const file of uploadFiles) {
      const target = path.join(this.config.uploadDir, file); const stat = await fs.stat(target).catch(() => null);
      if (stat && stat.mtimeMs < cutoff) await fs.rm(target, { force: true });
    }
  }

  async resumeQueuedJobs() {
    for (const row of this.db.prepare(`SELECT id FROM processing_jobs WHERE status IN ('queued','running')`).all()) {
      this.db.prepare(`UPDATE processing_jobs SET status='queued',updated_at=? WHERE id=?`).run(now(), row.id);
      setImmediate(() => this.processJob(row.id));
    }
  }

  audit(entityType, entityId, action, details = {}) {
    this.db.prepare('INSERT INTO audit_log(id,entity_type,entity_id,action,details_json,created_at) VALUES(?,?,?,?,?,?)')
      .run(uid(), entityType, entityId, action, JSON.stringify(details), now());
  }
}

function confidenceNumber(level) { return ({ high: 0.9, medium: 0.65, low: 0.35, unknown: null })[level] ?? null; }
function dateInZone(value,zone) {
  if(!value)return null; const date=new Date(value); if(Number.isNaN(date.getTime()))return String(value).slice(0,10);
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);
  const get=type=>parts.find(part=>part.type===type)?.value; return `${get('year')}-${get('month')}-${get('day')}`;
}

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const state = { view: location.hash.slice(1) || 'library', photos: [], plogs: [], settings: {}, selected: new Set(), search: '', searchResults:null, filters:{}, timer: null, showArchivedPlogs:false };

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...(options.body instanceof FormData ? {} : { 'content-type': 'application/json' }), ...options.headers } });
  const body = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(body.error || `请求失败 (${response.status})`); error.status = response.status; error.body = body; throw error; }
  return body;
}

function esc(value = '') { return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' })[char]); }
function fmtDate(value, full = false) {
  if (!value) return '时间未知'; const date = new Date(value); if (Number.isNaN(date.getTime())) return String(value).slice(0,10);
  return new Intl.DateTimeFormat('zh-CN', full ? { dateStyle:'long', timeStyle:'short' } : { month:'long', day:'numeric', weekday:'short' }).format(date);
}
function toast(message) { const el = $('#toast'); el.textContent = message; el.classList.remove('show'); requestAnimationFrame(() => el.classList.add('show')); }
function showError(error) { console.error(error); toast(error.message || '操作失败'); }
function statusText(status) { return ({ processing:'处理中',recognizing:'识别中',complete:'已完成',waiting_recognition:'待识别',cancelled:'已取消',trashed:'回收站' })[status] || status; }

async function boot() {
  bindGlobalEvents();
  await health();
  await navigate();
}

function bindGlobalEvents() {
  addEventListener('hashchange', navigate);
  $('#upload-button').onclick = () => $('#file-input').click();
  $('#file-input').onchange = event => uploadFiles(event.target.files);
  $('#import-package-input').onchange = event => importPackage(event.target.files?.[0]);
  $('#mobile-menu').onclick = () => $('.sidebar').classList.toggle('open');
  $('#nav').onclick = () => $('.sidebar').classList.remove('open');
  let searchTimer;
  $('#search').oninput = event => { clearTimeout(searchTimer); state.search = event.target.value; searchTimer = setTimeout(() => state.view === 'library' && renderLibrary(), 250); };
  $('#modal').addEventListener('click', event => { if (event.target === $('#modal')) closeModal(); });
  document.addEventListener('keydown', event => event.key === 'Escape' && closeModal());
}

async function health() {
  try {
    const result = await api('/api/health');
    $('#health-dot').className = 'health-dot ok'; $('#health-label').textContent = '服务正常';
    $('#provider-label').textContent = result.provider === 'demo' ? '演示识别模式' : 'Gemini 已配置';
  } catch { $('#health-dot').className = 'health-dot bad'; $('#health-label').textContent = '服务异常'; }
}

async function navigate() {
  state.view = location.hash.slice(1) || 'library'; state.selected.clear();
  $$('#nav a').forEach(a => a.classList.toggle('active', a.dataset.view === state.view));
  $('#search').closest('.search-wrap').style.display = state.view === 'library' ? 'flex' : 'none';
  try {
    if (state.view === 'library') await renderLibrary();
    else if (state.view === 'plogs') await renderPlogs();
    else if (state.view === 'topics') await renderTopics();
    else if (state.view === 'trash') await renderTrash();
    else if (state.view === 'settings') await renderSettings();
  } catch (error) { $('#content').innerHTML = empty('加载失败', error.message); }
}

async function refreshData() {
  [state.photos, state.plogs, state.settings] = await Promise.all([
    api(`/api/photos?${new URLSearchParams({...state.filters,...(state.search?{q:state.search}:{})})}`), api('/api/plogs'), api('/api/settings'),
  ]);
  state.searchResults=state.search?await api(`/api/search?q=${encodeURIComponent(state.search)}`):null;
  $('#draft-count').textContent = state.plogs.filter(p => p.status === 'draft').length || '';
  const [jobs,system] = await Promise.all([api('/api/jobs'),api('/api/system/status')]);
  const issues = jobs.filter(j => ['needs_attention','waiting_provider'].includes(j.status));
  const warnings=[];if(!system.storageOk)warnings.push('服务端存储空间不足，已停止接收新照片。');if(system.overdueOriginals)warnings.push(`有 ${system.overdueOriginals} 个临时原图超过 24 小时，MVP 验收已阻断。`);if(issues.length)warnings.push(`有 ${issues.length} 个处理任务需要关注。${issues.some(x => x.status === 'waiting_provider') ? '请在设置中确认模型数据处理授权。' : '可以打开照片详情后重试。'}`);$('#banner').innerHTML=warnings.join(' ');
  const active = jobs.some(j => ['queued','running'].includes(j.status));
  clearTimeout(state.timer); if (active && state.view === 'library') state.timer = setTimeout(renderLibrary, 2500);
}

async function renderLibrary() {
  await refreshData();
  const latestPlog = state.plogs[0]; const drafts = state.plogs.filter(x => x.status === 'draft').length;
  const groups = Object.groupBy(state.photos, photo => (photo.dateTaken || photo.createdAt || '').slice(0,10) || 'unknown');
  const grid = Object.entries(groups).map(([date, photos]) => `
    <div class="section-label">${esc(date === 'unknown' ? '时间未知' : fmtDate(`${date}T12:00:00`))}<span>${photos.length} 张</span></div>
    <div class="photo-grid">${photos.map(photoCard).join('')}</div>`).join('');
  $('#content').innerHTML = `
    <div class="page-head"><div><h1>照片日志</h1><p>${state.photos.length ? `已经整理 ${state.photos.length} 张照片` : '从第一张照片开始记录'}</p></div>
      <div class="page-actions"><button class="button" data-action="filters">筛选${Object.keys(state.filters).length?` · ${Object.keys(state.filters).length}`:''}</button><button class="button" data-action="select-all">全选</button></div></div>
    <div class="story-strip">
      <article class="story-card feature"><span class="eyebrow">最近的 Plog</span><h3>${esc(latestPlog?.title || '等待第一段故事')}</h3><p>${esc(latestPlog?.opening || '导入照片后，VisionLog 会把散落的瞬间整理成故事。')}</p>${latestPlog ? `<button class="button small" data-plog="${latestPlog.id}">打开阅读</button>` : ''}</article>
      <article class="story-card"><span class="eyebrow">待确认</span><h3>${drafts} 份草稿</h3><p>草稿不会自动发布，等你慢慢查看。</p></article>
      <article class="story-card"><span class="eyebrow">处理状态</span><h3>${state.photos.filter(p => p.status === 'complete').length} / ${state.photos.length}</h3><p>已完成结构化整理</p></article>
    </div>
    ${state.photos.length ? grid : empty(state.search?'没有匹配的照片':'还没有照片', state.search?'试试更短的关键词。':'点击右上角“导入照片”，支持一次选择多张。')}
    ${state.searchResults?.topics?.length?`<div class="section-label">匹配主题</div><div class="topic-grid">${state.searchResults.topics.map(t=>`<article class="topic-card"><h3>${esc(t.name)}</h3><p>${t.photo_count} 张照片</p></article>`).join('')}</div>`:''}
    ${state.searchResults?.plogs?.length?`<div class="section-label">匹配 Plog</div><div class="plog-grid">${state.searchResults.plogs.map(p=>`<article class="plog-card" data-plog="${p.id}"><h3>${esc(p.title)}</h3><p>${esc(p.opening)}</p><span>${p.members.length} 张照片</span></article>`).join('')}</div>`:''}
    <div id="selection"></div>`;
  bindLibraryEvents(); renderSelection();
}

function photoCard(photo) {
  const working = !['complete','trashed'].includes(photo.status);
  return `<article class="photo-card ${photo.sensitive !== 'none' && state.settings.sensitive_blur === 'true' ? 'sensitive' : ''}" data-photo="${photo.id}">
    <input class="photo-check" type="checkbox" data-select="${photo.id}" ${state.selected.has(photo.id) ? 'checked' : ''} aria-label="选择 ${esc(photo.effective.title || photo.name)}" />
    ${working ? `<span class="status-chip ${photo.status.includes('waiting') ? 'waiting' : ''}">${esc(statusText(photo.status))}</span>` : ''}
    <img src="${photo.thumbnailUrl}" loading="lazy" alt="${esc(photo.effective.title || photo.name)}" />
    <div class="photo-overlay"><b>${esc(photo.effective.title || photo.name)}</b><small>${esc(photo.effective.scene || statusText(photo.status))}</small></div>
  </article>`;
}

function bindLibraryEvents() {
  $('#content').onclick = event => {
    const select = event.target.closest('[data-select]');
    if (select) { event.stopPropagation(); select.checked ? state.selected.add(select.dataset.select) : state.selected.delete(select.dataset.select); return renderSelection(); }
    const photo = event.target.closest('[data-photo]'); if (photo) return openPhoto(photo.dataset.photo);
    const plog = event.target.closest('[data-plog]'); if (plog) return openPlog(plog.dataset.plog);
    if (event.target.closest('[data-action="select-all"]')) { state.photos.forEach(p => state.selected.add(p.id)); $$('.photo-check').forEach(x => x.checked = true); renderSelection(); }
    if(event.target.closest('[data-action="filters"]'))openFilters();
  };
}

async function openFilters(){const topics=await api('/api/topics');openModal(`<div class="modal-head"><h2>筛选照片</h2><button class="close" data-close>×</button></div><form class="detail-copy" id="filter-form"><div class="facts"><div class="field"><label>开始日期</label><input type="date" name="dateFrom" value="${esc(state.filters.dateFrom||'')}"/></div><div class="field"><label>结束日期</label><input type="date" name="dateTo" value="${esc(state.filters.dateTo||'')}"/></div></div><div class="field"><label>主题</label><select name="topicId"><option value="">全部</option>${topics.map(t=>`<option value="${t.id}" ${state.filters.topicId===t.id?'selected':''}>${esc(t.name)}</option>`).join('')}</select></div><div class="field"><label>处理状态</label><select name="status"><option value="">全部</option>${[['complete','已完成'],['waiting_recognition','待识别'],['cancelled','已取消']].map(([v,l])=>`<option value="${v}" ${state.filters.status===v?'selected':''}>${l}</option>`).join('')}</select></div><div class="field"><label>标签包含</label><input name="tag" value="${esc(state.filters.tag||'')}"/></div><div class="field"><label>地点包含</label><input name="location" value="${esc(state.filters.location||'')}"/></div><div class="field"><label>原始文件类型</label><select name="mime"><option value="">全部</option>${['image/jpeg','image/png','image/webp','image/heic','image/heif'].map(v=>`<option value="${v}" ${state.filters.mime===v?'selected':''}>${v.replace('image/','').toUpperCase()}</option>`).join('')}</select></div><div class="modal-actions"><button class="button primary">应用</button><button class="button" type="button" data-clear-filters>清除</button></div></form>`);$('#filter-form').onsubmit=event=>{event.preventDefault();const form=new FormData(event.target);state.filters=Object.fromEntries([...form.entries()].filter(([,v])=>v));closeModal();renderLibrary();};$('[data-clear-filters]').onclick=()=>{state.filters={};closeModal();renderLibrary();};}

function renderSelection() {
  const target = $('#selection'); if (!target) return;
  target.innerHTML = state.selected.size ? `<div class="selection-bar"><b>${state.selected.size} 张已选择</b><button class="button small" data-generate-selected>生成 Plog</button><button class="button small" data-batch="add_topic">加入主题</button><button class="button small" data-batch="re_recognize">重新识别</button><button class="button small" data-batch="archive">归档</button><button class="button small danger" data-batch="trash">删除</button><button class="button small ghost" data-clear-selected>取消</button></div>` : '';
  $('[data-clear-selected]')?.addEventListener('click', () => { state.selected.clear(); $$('.photo-check').forEach(x => x.checked = false); renderSelection(); });
  $('[data-generate-selected]')?.addEventListener('click', generateSelectedPlog);
  $$('[data-batch]').forEach(button=>button.addEventListener('click',()=>batchSelected(button.dataset.batch)));
}

async function batchSelected(action){let topicName;if(action==='add_topic'){topicName=prompt('输入主题名称');if(!topicName)return;}if(action==='trash'&&!confirm(`将 ${state.selected.size} 张照片移到回收站？`))return;try{const result=await api('/api/photos/batch',{method:'POST',body:JSON.stringify({ids:[...state.selected],action,topicName})});toast(`已处理 ${result.changed} 张${result.skipped?`，跳过 ${result.skipped} 张人工锁定照片`:''}`);state.selected.clear();renderLibrary();}catch(error){showError(error);}}

async function uploadFiles(files) {
  if (!files?.length) return;
  const overlay = document.createElement('div'); overlay.className = 'uploading'; overlay.innerHTML = `<div class="upload-box"><b>正在接收 ${files.length} 张照片</b><p>上传完成后会在后台压缩和识别。</p><div class="progress"><i></i></div></div>`; document.body.append(overlay);
  try {
    const form = new FormData(); [...files].forEach(file => form.append('photos', file));
    const result = await api('/api/photos/import', { method:'POST', body:form, headers: { 'x-visionlog-timezone': Intl.DateTimeFormat().resolvedOptions().timeZone } });
    toast(`${result.imported.length} 张照片已进入处理队列`); $('#file-input').value = ''; location.hash = 'library'; await renderLibrary();
  } catch (error) { showError(error); } finally { overlay.remove(); }
}

async function openPhoto(id) {
  try {
    const photo = await api(`/api/photos/${id}`); const v = photo.effective || {};
    openModal(`<div class="modal-head"><div><span class="pill">${esc(statusText(photo.status))}</span></div><button class="close" data-close>×</button></div>
      <div class="photo-detail"><div class="detail-image"><img src="${photo.imageUrl}" alt="${esc(v.title || photo.name)}" /></div>
      <form class="detail-copy" id="photo-form">
        <div class="field"><label>标题</label><input name="title" value="${esc(v.title || '')}" /></div>
        <div class="field"><label>摘要</label><textarea name="summary">${esc(v.summary || '')}</textarea></div>
        <div class="field"><label>描述</label><textarea name="description">${esc(v.description || '')}</textarea></div>
        <div class="facts"><div class="field"><label>拍摄时间</label><input type="datetime-local" name="dateTaken" value="${photo.dateTaken?esc(new Date(photo.dateTaken).toISOString().slice(0,16)):''}" /></div><div class="field"><label>地点名称</label><input name="location" value="${esc(v.location||'')}" /></div></div>
        <div class="field"><label>标签（逗号分隔）</label><input name="tags" value="${esc((v.tags || []).join(', '))}" /></div>
        <div class="field"><label>敏感内容</label><select name="sensitive">${[['none','非敏感'],['suggestive','可能敏感'],['explicit','成人内容'],['medical','医疗'],['violence','暴力'],['unknown','未知']].map(([value,label])=>`<option value="${value}" ${v.sensitive===value?'selected':''}>${label}</option>`).join('')}</select></div>
        <div class="field"><label>用户备注</label><textarea name="note">${esc(v.note || '')}</textarea></div>
        <div class="facts"><div class="fact"><small>拍摄时间</small><b>${esc(fmtDate(photo.dateTaken, true))}</b></div><div class="fact"><small>相机</small><b>${esc(photo.camera || '未知')}</b></div><div class="fact"><small>识别来源</small><b>${esc(photo.provider || '尚未识别')}</b></div><div class="fact"><small>版本</small><b>v${photo.version}${photo.locked ? ' · 人工锁定' : ''}</b></div></div>
        ${photo.sources?.length?`<div class="field"><label>设备来源（${photo.sources.length}）</label>${photo.sources.map(source=>`<div class="meta-row"><span>${esc(source.source_kind)} · ${esc(source.source_key)}</span>${photo.sources.length>1?`<button class="button small" type="button" data-remove-source="${source.id}">移除此来源</button>`:''}</div>`).join('')}</div>`:''}
        <div class="modal-actions"><button class="button primary" type="submit">保存修正</button>
          ${photo.locked ? `<button class="button" type="button" data-unlock>解除锁定</button><button class="button" type="button" data-restore-model>恢复模型</button>` : ''}
          ${photo.status === 'waiting_recognition' ? `<button class="button" type="button" data-retry-photo>重试识别</button>` : ''}
          ${['processing','recognizing'].includes(photo.status)?'<button class="button" type="button" data-cancel-photo>取消处理</button>':''}
          <button class="button" type="button" data-archive>${photo.archived ? '取消归档' : '归档'}</button><button class="button danger" type="button" data-trash>移到回收站</button></div>
      </form></div>`);
    $('#photo-form').onsubmit = async event => {
      event.preventDefault(); const data = new FormData(event.target);
      const overrides = { ...photo.overrides, title:data.get('title'), summary:data.get('summary'), description:data.get('description'), dateTaken:data.get('dateTaken')?new Date(data.get('dateTaken')).toISOString():undefined, location:data.get('location'), tags:String(data.get('tags')).split(',').map(x => x.trim()).filter(Boolean), sensitive:data.get('sensitive'), note:data.get('note') };
      try { await api(`/api/photos/${id}`, { method:'PATCH', body:JSON.stringify({ version:photo.version, overrides }) }); toast('修正已保存，Photo Log 已锁定'); closeModal(); renderLibrary(); }
      catch (error) { if (error.status === 409) toast('另一台设备刚刚更新了这张照片，请重新打开后合并'); else showError(error); }
    };
    $('[data-unlock]')?.addEventListener('click', () => photoAction(id, 'PATCH', { version:photo.version, action:'unlock' }, '已解除锁定'));
    $('[data-restore-model]')?.addEventListener('click', async () => { if (confirm('清除全部用户修正并恢复模型结果？')) photoAction(id, 'PATCH', { version:photo.version, action:'restore_model' }, '已恢复模型结果'); });
    $('[data-archive]').onclick = () => photoAction(`${id}/archive`, 'POST', { archived:!photo.archived }, photo.archived ? '已取消归档' : '已归档');
    $('[data-trash]').onclick = () => photoAction(`${id}/trash`, 'POST', {}, '已移到回收站');
    $('[data-retry-photo]')?.addEventListener('click', async () => { const jobs = await api('/api/jobs'); const job = jobs.find(x => x.asset_id === id); if (job) { await api(`/api/jobs/${job.id}/retry`, { method:'POST', body:'{}' }); toast('已重新排队'); closeModal(); renderLibrary(); } });
    $('[data-cancel-photo]')?.addEventListener('click',async()=>{const jobs=await api('/api/jobs');const job=jobs.find(x=>x.asset_id===id&&!['complete','cancelled'].includes(x.status));if(job){await api(`/api/jobs/${job.id}/cancel`,{method:'POST',body:'{}'});toast('已取消后续处理，成功的部分结果会保留');closeModal();renderLibrary();}});
    $$('[data-remove-source]').forEach(button=>button.onclick=async()=>{if(!confirm('移除此设备来源？服务端压缩图和其他来源会保留。'))return;await api(`/api/photos/${id}/sources/${button.dataset.removeSource}`,{method:'DELETE'});toast('来源已移除');closeModal();renderLibrary();});
  } catch (error) { showError(error); }
}

async function photoAction(path, method, body, message) { try { await api(`/api/photos/${path}`, { method, body:JSON.stringify(body) }); toast(message); closeModal(); await navigate(); } catch (error) { showError(error); } }

async function generateSelectedPlog() {
  const photoLogIds = state.photos.filter(p => state.selected.has(p.id)).map(p => p.photoLogId);
  try { const plog = await api('/api/plogs/generate', { method:'POST', body:JSON.stringify({ photoLogIds, kind:'manual' }) }); state.selected.clear(); toast('Plog 草稿已生成'); await openPlog(plog.id); }
  catch (error) { showError(error); }
}

async function renderPlogs() {
  state.plogs = await api(`/api/plogs${state.showArchivedPlogs?'?archived=true':''}`); $('#draft-count').textContent = state.showArchivedPlogs?'':state.plogs.filter(p => p.status === 'draft').length || '';
  $('#content').innerHTML = `<div class="page-head"><div><h1>${state.showArchivedPlogs?'已归档 Plog':'Plog'}</h1><p>由 Photo Log 整理出的图文叙事</p></div><div class="page-actions"><button class="button" data-toggle-plog-archive>${state.showArchivedPlogs?'返回当前':'查看归档'}</button><button class="button" data-daily>生成昨日 Plog</button></div></div>
    ${state.plogs.length ? `<div class="plog-grid">${state.plogs.map(plogCard).join('')}</div>` : empty('还没有 Plog', '在照片页选择一组照片，或生成昨日的日期 Plog。')}`;
  $('#content').onclick = event => { const card = event.target.closest('[data-plog]'); if (card) openPlog(card.dataset.plog); if (event.target.closest('[data-daily]')) generateDaily();if(event.target.closest('[data-toggle-plog-archive]')){state.showArchivedPlogs=!state.showArchivedPlogs;renderPlogs();} };
}

function plogCard(plog) { return `<article class="plog-card" data-plog="${plog.id}"><div class="plog-cover">${plog.coverPhotoLogId ? `<img src="/media-log/${plog.coverPhotoLogId}/thumbnail" alt="" />` : '<span>一段照片故事</span>'}</div><span class="pill">${plog.updateAvailable ? '有可用更新' : plog.status === 'draft' ? '待确认' : '已收录'}</span><h3>${esc(plog.title)}</h3><p>${esc(plog.opening)}</p><div class="meta-row"><span>${plog.members.length} 张照片${plog.incomplete ? ' · 不完整' : ''}</span><span>${fmtDate(plog.createdAt)}</span></div></article>`; }

async function generateDaily() {
  const d = new Date(Date.now() - 86400000); const date = d.toISOString().slice(0,10);
  try { const plog = await api('/api/plogs/generate', { method:'POST', body:JSON.stringify({ date, kind:'daily' }) }); toast('日期 Plog 已生成'); openPlog(plog.id); } catch (error) { showError(error); }
}

async function openPlog(id) {
  try {
    const plog = await api(`/api/plogs/${id}`);
    const byLog = Object.fromEntries(plog.photos.map(p => [p.photoLogId,p]));
    const sections = plog.body.map((part, i) => { const image = byLog[part.photoLogIds?.[0]]; return `<section class="story-section">${image && !image.deleted ? `<img src="${image.thumbnailUrl.replace('thumbnail','master')}" alt="" />` : image?.deleted ? '<div class="empty">引用照片已删除</div>' : ''}<p data-paragraph="${i}">${esc(part.text)}</p></section>`; }).join('');
    openModal(`<div class="modal-head"><span class="pill">${plog.updateAvailable ? '有可用更新' : plog.status === 'draft' ? '草稿 · 待确认' : '已确认收录'}</span><button class="close" data-close>×</button></div><article class="plog-detail"><header class="hero"><span>${esc(plog.kind === 'daily' ? '日期日志' : '选图日志')}</span><h2>${esc(plog.title)}</h2><p>${esc(plog.opening)}</p></header>${sections}<div class="modal-actions"><button class="button primary" data-confirm-plog>${plog.status === 'draft' ? '确认收录' : '已收录'}</button>${plog.updateAvailable ? `<button class="button" data-update-plog>${plog.pendingVersion ? '比较候选新版' : '生成候选新版'}</button>` : ''}<button class="button" data-edit-plog>编辑文字</button><button class="button" data-feedback>评价</button><button class="button" data-archive-plog>${state.showArchivedPlogs?'取消归档':'归档'}</button><button class="button danger" data-trash-plog>删除 Plog</button></div></article>`);
    $('[data-confirm-plog]').onclick = () => updatePlog(id, { status:'confirmed' }, '已确认收录');
    $('[data-trash-plog]').onclick = async () => { await api(`/api/plogs/${id}/trash`, { method:'POST', body:'{}' }); toast('Plog 已移到回收站，照片不受影响'); closeModal(); navigate(); };
    $('[data-edit-plog]').onclick = () => editPlog(plog);
    $('[data-feedback]').onclick = () => feedbackPlog(plog);
    $('[data-archive-plog]').onclick=async()=>{await api(`/api/plogs/${id}/archive`,{method:'POST',body:JSON.stringify({archived:!state.showArchivedPlogs})});toast(state.showArchivedPlogs?'已取消归档':'已归档');closeModal();renderPlogs();};
    $('[data-update-plog]')?.addEventListener('click',async()=>{try{const updated=plog.pendingVersion?plog:await api(`/api/plogs/${id}/regenerate`,{method:'POST',body:'{}'});comparePlogVersions(updated);}catch(error){showError(error);}});
  } catch (error) { showError(error); }
}

function comparePlogVersions(plog){const pending=plog.pendingVersion;openModal(`<div class="modal-head"><h2>比较候选新版</h2><button class="close" data-close>×</button></div><div class="detail-copy"><div class="facts"><div><span class="pill">当前 v${plog.currentVersion}</span><h3>${esc(plog.title)}</h3><p>${esc(plog.opening)}</p>${plog.body.map(p=>`<p>${esc(p.text)}</p>`).join('')}</div><div><span class="pill">候选 v${pending.version}</span><h3>${esc(pending.title)}</h3><p>${esc(pending.opening)}</p>${pending.body.map(p=>`<p>${esc(p.text)}</p>`).join('')}</div></div><div class="modal-actions"><button class="button primary" data-accept-update>采用新版</button><button class="button" data-reject-update>保留当前版</button></div></div>`);$('[data-accept-update]').onclick=()=>resolvePlogUpdate(plog.id,true);$('[data-reject-update]').onclick=()=>resolvePlogUpdate(plog.id,false);}
async function resolvePlogUpdate(id,accept){try{await api(`/api/plogs/${id}/resolve-update`,{method:'POST',body:JSON.stringify({accept})});toast(accept?'已采用候选新版':'已保留当前版本');closeModal();renderPlogs();}catch(error){showError(error);}}

function editPlog(plog) {
  openModal(`<div class="modal-head"><h2>编辑 Plog 文字</h2><button class="close" data-close>×</button></div><form class="detail-copy" id="plog-edit"><div class="field"><label>标题</label><input name="title" value="${esc(plog.title)}" /></div><div class="field"><label>开场</label><textarea name="opening">${esc(plog.opening)}</textarea></div><div class="field"><label>封面</label><select name="coverPhotoLogId">${plog.photos.filter(p=>!p.deleted).map((p,i)=>`<option value="${p.photoLogId}" ${p.photoLogId===plog.coverPhotoLogId?'selected':''}>成员照片 ${i+1}</option>`).join('')}</select></div>${plog.body.map((p,i) => `<div class="field"><label>第 ${i+1} 段</label><textarea name="p${i}">${esc(p.text)}</textarea></div>`).join('')}<button class="button primary">保存文字</button></form>`);
  $('#plog-edit').onsubmit = async event => { event.preventDefault(); const form = new FormData(event.target); await updatePlog(plog.id, { title:form.get('title'), opening:form.get('opening'), coverPhotoLogId:form.get('coverPhotoLogId'), body:plog.body.map((p,i) => ({ ...p,text:form.get(`p${i}`) })) }, 'Plog 已更新'); };
}

function feedbackPlog(plog) {
  openModal(`<div class="modal-head"><h2>这份 Plog 怎么样？</h2><button class="close" data-close>×</button></div><form class="detail-copy" id="feedback-form"><div class="field"><label>评价</label><select name="feedback"><option value="usable">可直接使用</option><option value="wrong_selection">选图有误</option><option value="wrong_topic">主题有误</option><option value="wrong_text">文案有误</option></select></div><div class="field"><label>备注（可选）</label><textarea name="note"></textarea></div><button class="button primary">提交</button></form>`);
  $('#feedback-form').onsubmit = event => { event.preventDefault(); const form = new FormData(event.target); updatePlog(plog.id, { feedback:form.get('feedback'), feedbackNote:form.get('note') }, '感谢反馈'); };
}

async function updatePlog(id, body, message) { try { await api(`/api/plogs/${id}`, { method:'PATCH', body:JSON.stringify(body) }); toast(message); closeModal(); navigate(); } catch (error) { showError(error); } }

async function renderTopics() {
  const topics = await api('/api/topics');
  $('#content').innerHTML = `<div class="page-head"><div><h1>动态主题</h1><p>模型提出主题，你决定它们是否值得长期保留</p></div></div>${topics.length ? `<div class="topic-grid">${topics.map(topic => `<article class="topic-card"><span class="pill">${topic.status === 'candidate' ? '待确认' : topic.status==='archived'?'已归档':topic.auto_created ? '自动建立' : '已确认'}</span><h3>${esc(topic.name)}</h3><p>${topic.photo_count} 张候选照片</p>${topic.status === 'candidate' ? `<button class="button small" data-confirm-topic="${topic.id}">确认主题</button>` : `<div class="page-actions"><button class="button small" data-topic-plog="${topic.id}">生成 Plog</button><button class="button small" data-manage-topic="${topic.id}">管理</button></div>`}</article>`).join('')}</div>` : empty('还没有主题', '真实视觉识别完成后，候选主题会出现在这里。')}`;
  $('#content').onclick = async event => { const button = event.target.closest('[data-confirm-topic]'); if (button) confirmTopic(button.dataset.confirmTopic, topics.find(x => x.id === button.dataset.confirmTopic)); const manage=event.target.closest('[data-manage-topic]');if(manage)manageTopic(topics.find(x=>x.id===manage.dataset.manageTopic),topics);const generate=event.target.closest('[data-topic-plog]');if(generate){const topic=topics.find(x=>x.id===generate.dataset.topicPlog);try{const plog=await api('/api/plogs/generate',{method:'POST',body:JSON.stringify({photoLogIds:topic.photoLogIds,kind:'topic',topicId:topic.id})});openPlog(plog.id);}catch(error){showError(error);}} };
}

function manageTopic(topic,topics){openModal(`<div class="modal-head"><h2>管理主题</h2><button class="close" data-close>×</button></div><form class="detail-copy" id="manage-topic"><div class="field"><label>名称</label><input name="name" value="${esc(topic.name)}" required/></div><div class="field"><label>合并另一个主题到当前主题</label><select name="sourceId"><option value="">不合并</option>${topics.filter(t=>t.id!==topic.id).map(t=>`<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></div><div class="modal-actions"><button class="button primary">保存</button><button class="button" type="button" data-archive-topic>${topic.status==='archived'?'取消归档':'归档'}</button><button class="button danger" type="button" data-delete-topic>删除分类</button></div></form>`);$('#manage-topic').onsubmit=async event=>{event.preventDefault();const form=new FormData(event.target);await api(`/api/topics/${topic.id}`,{method:'PATCH',body:JSON.stringify({name:form.get('name')})});if(form.get('sourceId'))await api(`/api/topics/${topic.id}/merge`,{method:'POST',body:JSON.stringify({sourceId:form.get('sourceId')})});toast('主题已更新');closeModal();renderTopics();};$('[data-archive-topic]').onclick=async()=>{await api(`/api/topics/${topic.id}`,{method:'PATCH',body:JSON.stringify({archived:topic.status!=='archived'})});toast('主题状态已更新');closeModal();renderTopics();};$('[data-delete-topic]').onclick=async()=>{if(!confirm('删除主题分类？既有 Plog 会保留生成时的名称快照。'))return;await api(`/api/topics/${topic.id}`,{method:'DELETE'});toast('主题分类已删除');closeModal();renderTopics();};}

function confirmTopic(id, topic) {
  openModal(`<div class="modal-head"><h2>确认主题</h2><button class="close" data-close>×</button></div><form class="detail-copy" id="topic-form"><div class="field"><label>主题名称</label><input name="name" value="${esc(topic.name)}" required /></div><p>确认后，当前 ${topic.photo_count} 张候选照片会加入这个主题。</p><button class="button primary">确认名称与成员</button></form>`);
  $('#topic-form').onsubmit = async event => { event.preventDefault(); const form = new FormData(event.target); await api(`/api/topics/${id}/confirm`, { method:'POST', body:JSON.stringify({ name:form.get('name'), photoLogIds:topic.photoLogIds }) }); toast('主题已确认'); closeModal(); renderTopics(); };
}

async function renderTrash() {
  const [photos, plogs] = await Promise.all([api('/api/photos?trash=true'), api('/api/plogs?trash=true')]);
  $('#content').innerHTML = `<div class="page-head"><div><h1>回收站</h1><p>内容保留 30 天，之后永久清理</p></div></div><div class="section-label">照片 · ${photos.length}</div>${photos.length ? `<div class="photo-grid">${photos.map(p => `<article class="photo-card" data-trash-photo="${p.id}"><img src="${p.thumbnailUrl}" alt="${esc(p.effective.title || p.name)}"/><div class="photo-overlay"><b>${esc(p.effective.title || p.name)}</b><small>${fmtDate(p.trashedAt)}</small></div></article>`).join('')}</div>` : '<p class="empty">没有已删除照片</p>'}<div class="section-label">Plog · ${plogs.length}</div>${plogs.length ? `<div class="plog-grid">${plogs.map(plogCard).join('')}</div>` : '<p class="empty">没有已删除 Plog</p>'}`;
  $('#content').onclick = event => { const p = event.target.closest('[data-trash-photo]'); if (p) trashActions('photos',p.dataset.trashPhoto); const plog = event.target.closest('[data-plog]'); if (plog) trashActions('plogs',plog.dataset.plog); };
}

function trashActions(kind,id) { openModal(`<div class="modal-head"><h2>回收站操作</h2><button class="close" data-close>×</button></div><div class="detail-copy"><p>恢复后会重新出现在资料库。永久删除不可撤销。</p><div class="modal-actions"><button class="button primary" data-restore>恢复</button><button class="button danger" data-purge>永久删除</button></div></div>`); $('[data-restore]').onclick = async () => { await api(`/api/${kind}/${id}/restore`,{method:'POST',body:'{}'});toast('已恢复');closeModal();renderTrash(); }; $('[data-purge]').onclick = async () => { if(confirm('确定永久删除？此操作不可撤销。')) { await api(`/api/${kind}/${id}`,{method:'DELETE'});toast('已永久删除');closeModal();renderTrash(); } }; }

async function renderSettings() {
  state.settings = await api('/api/settings'); const s = state.settings;
  $('#content').innerHTML = `<div class="page-head"><div><h1>设置</h1><p>这些设置对 Tailnet 内所有设备生效</p></div></div><form class="settings-stack" id="settings-form">
    <section class="settings-card"><h2>整理习惯</h2><p>每日 Plog 按这里的时区与时间触发。</p><div class="field"><label>默认时区</label><input name="timezone" value="${esc(s.timezone)}" /></div><div class="field"><label>每日生成小时（0–23）</label><input name="plog_hour" type="number" min="0" max="23" value="${esc(s.plog_hour)}" /></div><div class="toggle-row"><span><b>模糊敏感缩略图</b><br><small>只影响列表，原图仍可在详情查看</small></span><input class="toggle" name="sensitive_blur" type="checkbox" ${s.sensitive_blur === 'true' ? 'checked' : ''}/></div></section>
    <section class="settings-card"><h2>视觉模型</h2><p>当前：${esc(s.provider)} · ${esc(s.model)}</p>${s.provider === 'gemini' && s.provider_tier === 'free' ? '<p><b>免费服务风险：</b>输入输出可能用于产品改进，并可能被人工审核。私人照片可能含敏感和个人信息。</p>' : ''}<div class="toggle-row"><span><b>允许向当前 Provider 发送照片</b><br><small>撤回后新识别任务会暂停，已有结果保留</small></span><input class="toggle" name="provider_consent" type="checkbox" ${s.provider_consent === 'true' ? 'checked' : ''}/></div></section>
    <section class="settings-card"><h2>维护</h2><p>立即执行过期回收、临时原图清理，并尝试生成昨日 Plog。</p><button class="button" type="button" data-maintenance>立即执行</button></section>
    <section class="settings-card"><h2>迁移数据</h2><p>导出包含压缩图、Photo Log、主题、Plog、关系与用户修正。导入只允许在空白实例执行，不包含密钥、设备 URI 或授权状态。</p><div class="page-actions"><button class="button" type="button" data-export>生成完整导出包</button><button class="button" type="button" data-import>导入到空白实例</button></div></section>
    <section class="settings-card"><h2>清空资料库</h2><p>全部内容会进入 30 天回收站，并记录最小来源标记，避免 Android 后台立即重新同步。</p><div class="page-actions"><button class="button danger" type="button" data-clear-library>清空全部内容</button><button class="button" type="button" data-reset-import>允许重新导入已永久删除的来源</button></div></section>
    <button class="button primary">保存设置</button></form>`;
  $('#settings-form').onsubmit = async event => { event.preventDefault(); const form = new FormData(event.target); await api('/api/settings',{method:'PATCH',body:JSON.stringify({timezone:form.get('timezone'),plog_hour:form.get('plog_hour'),sensitive_blur:form.get('sensitive_blur')?'true':'false',provider_consent:form.get('provider_consent')?'true':'false'})});toast('设置已保存');renderSettings(); };
  $('[data-maintenance]').onclick = async () => { await api('/api/maintenance/run',{method:'POST',body:'{}'});toast('维护任务已完成'); };
  $('[data-export]').onclick = exportPackage;
  $('[data-import]').onclick = () => $('#import-package-input').click();
  $('[data-clear-library]').onclick = clearLibraryDialog;
  $('[data-reset-import]').onclick = async () => { if (!confirm('这会允许 Android 再次同步曾被永久删除的来源，确定继续？')) return; const result=await api('/api/library/reset-import-protection',{method:'POST',body:'{}'});toast(`已移除 ${result.removed} 条来源保护`); };
}

async function exportPackage() {
  try {
    toast('正在生成导出包…'); const response=await fetch('/api/library/export',{method:'POST',headers:{'content-type':'application/json'},body:'{"includeDebug":false}'});
    if(!response.ok) throw new Error((await response.json()).error||'导出失败');
    const blob=await response.blob(), url=URL.createObjectURL(blob), link=document.createElement('a');
    link.href=url;link.download=`visionlog-${new Date().toISOString().slice(0,10)}.tar.gz`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('导出包已生成');
  } catch(error){showError(error);}
}

async function importPackage(file) {
  if(!file)return; const overlay=document.createElement('div');overlay.className='uploading';overlay.innerHTML='<div class="upload-box"><b>正在验证并导入</b><p>导入期间请不要关闭页面。</p><div class="progress"><i></i></div></div>';document.body.append(overlay);
  try { const form=new FormData();form.append('package',file);const result=await api('/api/library/import',{method:'POST',body:form});toast(`已导入 ${result.imported.photo_assets} 张照片`);location.hash='library';await renderLibrary(); }
  catch(error){showError(error);}finally{overlay.remove();$('#import-package-input').value='';}
}

function clearLibraryDialog() {
  openModal(`<div class="modal-head"><h2>清空全部内容</h2><button class="close" data-close>×</button></div><form class="detail-copy" id="clear-form"><p>照片、Photo Log、Topic 关系和 Plog 将进入回收站。输入 <b>清空我的 VisionLog</b> 继续。</p><div class="field"><label>确认短语</label><input name="phrase" autocomplete="off" required /></div><button class="button danger">放入回收站</button></form>`);
  $('#clear-form').onsubmit = async event => { event.preventDefault(); const phrase=new FormData(event.target).get('phrase'); try { const result=await api('/api/library/clear',{method:'POST',body:JSON.stringify({phrase})});toast(`已将 ${result.photos} 张照片和 ${result.plogs} 份 Plog 放入回收站`);closeModal();location.hash='trash'; } catch(error){showError(error);} };
}

function openModal(html) { const dialog = $('#modal'); $('#modal-content').innerHTML = html; $$('[data-close]', dialog).forEach(x => x.onclick = closeModal); dialog.showModal(); }
function closeModal() { const dialog = $('#modal'); if (dialog.open) dialog.close(); $('#modal-content').innerHTML = ''; }
function empty(title, text) { return `<div class="empty"><b>${esc(title)}</b><span>${esc(text)}</span></div>`; }

boot().catch(showError);

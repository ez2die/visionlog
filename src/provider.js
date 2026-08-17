import fs from 'node:fs/promises';
import { z } from 'zod';

const confidence = z.enum(['high', 'medium', 'low', 'unknown']);
export const RecognitionSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  description: z.string().min(1),
  scene: z.string().min(1),
  tags: z.array(z.string().min(1)).min(1),
  objects: z.array(z.string()).default([]),
  peopleCount: z.number().int().nonnegative().nullable().default(null),
  sensitive: z.enum(['none', 'suggestive', 'explicit', 'medical', 'violence', 'unknown']),
  candidateTopics: z.array(z.object({ name: z.string().min(1), confidence })).default([]),
  confidence: z.object({
    title: confidence, summary: confidence, description: confidence, scene: confidence,
    tags: confidence, sensitive: confidence,
  }),
});

const geminiJsonSchema = {
  type: 'object',
  required: ['title','summary','description','scene','tags','objects','peopleCount','sensitive','candidateTopics','confidence'],
  properties: {
    title: { type: 'string' }, summary: { type: 'string' }, description: { type: 'string' }, scene: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } }, objects: { type: 'array', items: { type: 'string' } },
    peopleCount: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
    sensitive: { type: 'string', enum: ['none','suggestive','explicit','medical','violence','unknown'] },
    candidateTopics: { type: 'array', items: { type: 'object', required: ['name','confidence'], properties: {
      name: { type: 'string' }, confidence: { type: 'string', enum: ['high','medium','low','unknown'] },
    } } },
    confidence: { type: 'object', required: ['title','summary','description','scene','tags','sensitive'], properties: Object.fromEntries(
      ['title','summary','description','scene','tags','sensitive'].map(key => [key, { type: 'string', enum: ['high','medium','low','unknown'] }])
    ) },
  },
};

export function createProvider(config, settings) {
  if (config.geminiKey) return new GeminiProvider(config, settings);
  return new DemoProvider();
}

export class DemoProvider {
  name = 'demo';
  modelId = 'deterministic-demo-v1';
  async recognize({ originalName }) {
    const stem = originalName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || '未命名照片';
    const structured = {
      title: stem, summary: `导入的照片「${stem}」`,
      description: '演示模式已完成结构化建档；配置 Gemini 后可获得真实视觉描述。',
      scene: 'unknown', tags: ['待真实识别'], objects: [], peopleCount: null, sensitive: 'unknown',
      candidateTopics: [], confidence: Object.fromEntries(['title','summary','description','scene','tags','sensitive'].map(k => [k, 'unknown'])),
    };
    return { structured: RecognitionSchema.parse(structured), raw: structured, provider: this.name, modelId: this.modelId };
  }

  async composePlog({ logs, dateLabel }) {
    const cited = logs.slice(0, 8);
    return {
      title: dateLabel ? `${dateLabel} · 照片日志` : '一组照片的记录',
      opening: `这份记录由 ${logs.length} 张照片整理而成。`,
      paragraphs: cited.map(log => ({
        text: `${log.title}。${log.summary}`,
        photoLogIds: [log.id], factFields: ['title', 'summary'],
      })),
      coverPhotoLogId: cited[0]?.id ?? null,
    };
  }
}

export class GeminiProvider {
  name = 'gemini';
  constructor(config, settings) { this.config = config; this.settings = settings; this.modelId = config.geminiModel; }

  assertConsent() {
    if (this.settings.provider_consent !== 'true') {
      const error = new Error('Gemini 尚未获得数据处理授权'); error.code = 'PROVIDER_CONSENT_REQUIRED'; throw error;
    }
  }

  async recognize({ imagePath, mimeType, facts }) {
    this.assertConsent();
    const bytes = await fs.readFile(imagePath);
    const prompt = `你是个人照片日志的视觉整理器。只描述图中可见事实；未知请保留 unknown/null，不推测人物身份、关系、精确地点或事件。输出简体中文。已验证上下文：${JSON.stringify({
      dateTaken: facts.exifDateTaken, latitude: facts.latitude, longitude: facts.longitude,
    })}`;
    const raw = await this.request([
      { text: prompt },
      { inlineData: { mimeType: mimeType === 'image/webp' ? mimeType : 'image/webp', data: bytes.toString('base64') }, mediaResolution: { level: 'MEDIA_RESOLUTION_HIGH' } },
    ], geminiJsonSchema);
    const parsed = JSON.parse(extractText(raw));
    return { structured: RecognitionSchema.parse(parsed), raw, provider: this.name, modelId: this.modelId };
  }

  async composePlog({ logs, dateLabel }) {
    this.assertConsent();
    const input = logs.map(({ id, title, summary, description, scene, tags, dateTaken }) => ({ id, title, summary, description, scene, tags, dateTaken }));
    const schema = {
      type: 'object', required: ['title','opening','paragraphs','coverPhotoLogId'], properties: {
        title: { type: 'string' }, opening: { type: 'string' }, coverPhotoLogId: { type: ['string','null'] },
        paragraphs: { type: 'array', items: { type: 'object', required: ['text','photoLogIds','factFields'], properties: {
          text: { type: 'string' }, photoLogIds: { type: 'array', items: { type: 'string' } }, factFields: { type: 'array', items: { type: 'string' } },
        } } },
      },
    };
    const raw = await this.request([{ text: `把这些 Photo Log 写成克制、准确的简体中文图文故事。不得添加输入中没有的人物身份、关系、地点或事件。每段必须列出支撑它的 photoLogIds 与 factFields。日期：${dateLabel || '未指定'}\n${JSON.stringify(input)}` }], schema);
    return JSON.parse(extractText(raw));
  }

  async request(parts, responseSchema) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.modelId)}:generateContent`;
    const response = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': this.config.geminiKey },
      body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: {
        responseMimeType: 'application/json', responseJsonSchema: responseSchema, temperature: 0.2,
      } }), signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      const error=new Error(`Gemini ${response.status}: ${(await response.text()).slice(0, 500)}`);
      if(response.status===429||response.status>=500)error.code='PROVIDER_TEMPORARY';
      throw error;
    }
    return response.json();
  }
}

function extractText(raw) {
  const text = raw?.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('');
  if (!text) throw new Error('Gemini 未返回结构化内容');
  return text;
}

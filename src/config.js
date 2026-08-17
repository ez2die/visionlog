import path from 'node:path';

export function loadConfig(env = process.env) {
  const root = path.resolve(env.VISIONLOG_DATA_DIR || './data');
  return {
    host: env.VISIONLOG_HOST || '0.0.0.0',
    port: Number(env.VISIONLOG_PORT || 4173),
    dataDir: root,
    dbPath: path.join(root, 'visionlog.sqlite'),
    uploadDir: path.join(root, 'uploads'),
    imageDir: path.join(root, 'images'),
    timezone: env.VISIONLOG_TIMEZONE || 'Asia/Shanghai',
    plogHour: Number(env.VISIONLOG_PLOG_HOUR || 3),
    minFreeBytes: Number(env.VISIONLOG_MIN_FREE_BYTES || 1024 * 1024 * 1024),
    geminiKey: env.GEMINI_API_KEY || '',
    geminiModel: env.GEMINI_MODEL || 'gemini-3.6-flash',
    geminiTier: env.GEMINI_TERMS_TIER || 'paid',
    geminiConsented: env.GEMINI_CONSENTED === 'true',
  };
}

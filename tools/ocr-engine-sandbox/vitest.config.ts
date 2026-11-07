import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', include: ['tools/ocr-engine-sandbox/*.test.ts'] } });

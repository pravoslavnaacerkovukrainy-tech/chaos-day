import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError } from './errors.ts';

export const JSON_BODY_LIMIT = 8 * 1024 * 1024;
export const IMPORT_BODY_LIMIT = 64 * 1024 * 1024;

export function sendJson(res: ServerResponse, status: number, payload: Record<string, unknown>): void {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.byteLength),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(body);
}

export function sendOk(res: ServerResponse, data: unknown, status = 200): void {
  sendJson(res, status, { ok: true, data });
}

export function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}

export function sendFromError(res: ServerResponse, error: unknown): void {
  if (error instanceof ApiError) {
    sendError(res, error.status, error.code, error.message);
    return;
  }
  if (error instanceof SyntaxError) {
    sendError(res, 400, 'invalid_request', 'Тело запроса не является корректным JSON.');
    return;
  }
  // В ответ не попадают стек, SQL и путь к файлу данных.
  const message = error instanceof Error ? error.message : String(error);
  sendError(res, 500, 'internal', `Внутренняя ошибка: ${message}`);
}

export function sendFile(
  res: ServerResponse,
  status: number,
  body: string,
  contentType: string,
  downloadName?: string,
): void {
  const buffer = Buffer.from(body, 'utf8');
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Content-Length': String(buffer.byteLength),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
  if (downloadName) {
    headers['Content-Disposition'] = `attachment; filename="${downloadName}"`;
  }
  res.writeHead(status, headers);
  res.end(buffer);
}

export async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.byteLength;
    if (size > limit) {
      throw new ApiError(413, 'payload_too_large', 'Файл слишком большой.');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export async function readJsonBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const buffer = await readBody(req, limit);
  if (buffer.byteLength === 0) return {};
  const text = buffer.toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, 'invalid_request', 'Тело запроса не является корректным JSON.');
  }
}

export async function readTextBody(req: IncomingMessage, limit: number): Promise<string> {
  const buffer = await readBody(req, limit);
  return buffer.toString('utf8');
}

export function contentTypeIsJson(req: IncomingMessage): boolean {
  const header = req.headers['content-type'];
  if (!header) return false;
  return header.toLowerCase().includes('application/json');
}

export function hasBody(req: IncomingMessage): boolean {
  const length = req.headers['content-length'];
  if (req.headers['transfer-encoding'] !== undefined) return true;
  return length !== undefined && Number(length) > 0;
}

export function clientIp(req: IncomingMessage): string {
  const socket = req.socket;
  return socket?.remoteAddress ?? 'unknown';
}

export function isSecureRequest(req: IncomingMessage): boolean {
  const forwarded = req.headers['x-forwarded-proto'];
  if (typeof forwarded === 'string' && forwarded.split(',')[0]?.trim().toLowerCase() === 'https') {
    return true;
  }
  const socket = req.socket as { encrypted?: boolean } | undefined;
  return socket?.encrypted === true;
}

export function flag(value: string | null, fallback = false): boolean {
  if (value === null || value === undefined || value === '') return fallback;
  const normalized = value.toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

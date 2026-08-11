import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import type { VisualAnalysisResult } from '../types.js';
import type { ExtractedFrame } from '../media/video-analysis.js';
import { CaptionEngineError } from '../errors.js';
import { safeErrorDetail } from './llm.js';

/**
 * Vision AI client for visual Auto Trim.
 *
 * Same posture as clips/llm.ts: the core batching/parsing logic depends on no
 * specific vendor, only on `VisionComplete`, so a different Vision endpoint
 * can be dropped in later without touching anything else in this file.
 */

/** Injected so this module has no hard dependency on any specific Vision provider. */
export type VisionComplete = (
  images: Array<{ index: number; base64: string; mediaType: string }>,
  prompt: string,
) => Promise<string>;

export interface VisionBatchOptions {
  /** Frames sent per Vision AI call. */
  batchSize?: number;
}

export const DEFAULT_VISION_BATCH_SIZE = 10;

export function buildVisualAnalysisPrompt(batch: ExtractedFrame[]): string {
  return `You are a professional video editor analyzing frames from a raw video.

Below are ${batch.length} frames, in order, each labelled with its index. Look at each frame and decide whether the footage at that moment is "odd" or unusable — for example: the speaker is looking away from the camera, the frame is blurry, the camera is moving wildly, the shot is covered/obstructed, or the frame is otherwise not something a video editor would keep in a final cut. A normal frame of the speaker talking to camera is usable.

Return ONLY valid JSON, no prose, in this exact shape:
{"frames":[{"index":<int>,"usable":<boolean>,"reason":"<short reason, a few words>"}]}

Judge every one of the ${batch.length} frames. Frame indices for this batch: ${batch.map((_, i) => i).join(', ')}.`;
}

/** Parse the Vision AI response back into results with real timestamps. */
export function parseVisualAnalysisResponse(
  raw: string,
  batch: ExtractedFrame[],
): VisualAnalysisResult[] {
  // Vision models wrap JSON in prose or code fences no matter how firmly you ask.
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return [];

  let parsed: { frames?: Array<Record<string, unknown>> };
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return [];
  }

  const out: VisualAnalysisResult[] = [];
  for (const f of parsed.frames ?? []) {
    const idx = Number(f.index);
    if (!Number.isFinite(idx)) continue;
    const i = Math.max(0, Math.min(Math.trunc(idx), batch.length - 1));
    const frame = batch[i];
    if (!frame) continue;

    out.push({
      timestampSec: frame.timestampSec,
      usable: Boolean(f.usable),
      reason: String(f.reason ?? '').slice(0, 200),
    });
  }
  return out;
}

const MEDIA_TYPE_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

function mediaTypeFor(path: string): string {
  return MEDIA_TYPE_BY_EXT[extname(path).toLowerCase()] ?? 'image/jpeg';
}

/** Full pipeline: batch → base64 → prompt → parse → concatenate. */
export async function analyzeFrames(
  frames: ExtractedFrame[],
  complete: VisionComplete,
  opts: VisionBatchOptions = {},
): Promise<VisualAnalysisResult[]> {
  const batchSize = opts.batchSize ?? DEFAULT_VISION_BATCH_SIZE;
  const out: VisualAnalysisResult[] = [];

  for (let i = 0; i < frames.length; i += batchSize) {
    const batch = frames.slice(i, i + batchSize);
    if (batch.length === 0) continue;
    try {
      const images = batch.map((f, k) => ({
        index: k,
        base64: readFileSync(f.path).toString('base64'),
        mediaType: mediaTypeFor(f.path),
      }));
      const raw = await complete(images, buildVisualAnalysisPrompt(batch));
      out.push(...parseVisualAnalysisResponse(raw, batch));
    } catch {
      // One bad batch shouldn't sink the whole job — a partial result set is
      // still useful, same tolerance findClips() applies to a bad LLM chunk.
      continue;
    }
  }

  return out;
}

/**
 * Minimal Anthropic Messages API client for visual Auto Trim, using Claude's
 * vision support (image content blocks). Same shape as
 * `makeAnthropicCompletion` in clips/llm.ts — deliberately dependency-free,
 * one POST per batch.
 */
export function makeAnthropicVisionCompletion(
  apiKey: string,
  model = 'claude-sonnet-4-5',
): VisionComplete {
  return async (images, prompt): Promise<string> => {
    const content: Array<Record<string, unknown>> = images.map((img) => ({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
    }));
    content.push({ type: 'text', text: prompt });

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        messages: [{ role: 'user', content }],
      }),
    });

    if (!res.ok) {
      // See clips/llm.ts:safeErrorDetail — never interpolate a raw provider
      // body into an error; some gateways echo the offending header back.
      const detail = await safeErrorDetail(res);
      throw new CaptionEngineError(
        `Video analysis request failed (${res.status}${detail ? `: ${detail}` : ''}).`,
        res.status === 401 || res.status === 403
          ? 'Check ANTHROPIC_API_KEY.'
          : 'Retry, or omit --analyze-video to skip visual analysis.',
      );
    }

    const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    return (data.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
  };
}

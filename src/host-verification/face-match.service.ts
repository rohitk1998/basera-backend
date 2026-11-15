import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type FaceMatchResult = { status: 'scored'; score: number } | { status: 'unavailable' };

const TIMEOUT_MS = 30_000;

/**
 * Talks to an optional self-hosted worker (InsightFace/DeepFace in Python). Images are sent from
 * memory and never written to disk here. With no worker configured the case still reaches the
 * admin queue with face_status = unavailable and the admin compares the faces by eye.
 */
@Injectable()
export class FaceMatchService {
  private readonly logger = new Logger(FaceMatchService.name);

  constructor(private readonly config: ConfigService) {}

  async score(idImage: Buffer, frames: Buffer[]): Promise<FaceMatchResult> {
    const url = this.config.get<string>('FACE_MATCH_URL');
    if (!url) return { status: 'unavailable' };

    try {
      const res = await fetch(`${url.replace(/\/+$/, '')}/match`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-worker-secret': this.config.get<string>('FACE_MATCH_SECRET') ?? '',
        },
        body: JSON.stringify({
          id_image: idImage.toString('base64'),
          frames: frames.map((f) => f.toString('base64')),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        this.logger.warn(`face-match worker answered ${res.status}`);
        return { status: 'unavailable' };
      }
      const body = (await res.json()) as { similarity?: unknown };
      return typeof body.similarity === 'number' && Number.isFinite(body.similarity)
        ? { status: 'scored', score: Math.max(-1, Math.min(1, body.similarity)) }
        : { status: 'unavailable' };
    } catch (err) {
      this.logger.warn(`face-match worker unreachable: ${(err as Error).message}`);
      return { status: 'unavailable' };
    }
  }
}

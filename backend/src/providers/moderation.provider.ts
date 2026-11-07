import { Injectable } from '@nestjs/common';
import { callJson } from './http';

export interface PhotoAnalysis {
  hasClearFace: boolean;
  faceMatchesUser: boolean | null; // compared with the liveness selfie face
  nudity: boolean;
  stockOrCelebrity: boolean;       // reverse image / known-face match
  aiGenerated: boolean;
}

/**
 * Photo checks: face present, face match vs selfie, nudity, stock/celebrity photo, AI-generated face.
 * One HTTP contract so the moderation vendor can be swapped without touching business logic.
 */
@Injectable()
export class ModerationProvider {
  async analyzePhoto(imageUrl: string, faceTemplateId: string | null): Promise<PhotoAnalysis> {
    return callJson<PhotoAnalysis>(`${process.env.MODERATION_API_URL}/photos/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.MODERATION_API_KEY}` },
      body: JSON.stringify({ imageUrl, faceTemplateId, checks: ['face', 'face_match', 'nudity', 'stock', 'celebrity', 'ai_generated'] }),
      timeoutMs: 30_000,
    });
  }
}

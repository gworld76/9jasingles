import { createHmac } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { callJson } from './http';

export type KycDocType = 'NIN' | 'NIGERIAN_PASSPORT';

export interface KycJobRequest {
  userId: string;
  jobId: string;
  route: 'SELFIE_ONLY' | 'NIGERIAN_ID_SELFIE';
  isReverification?: boolean; // fresh selfie compared against the face enrolled at first verification
  documentType?: KycDocType;
  documentNumber?: string;
  callbackUrl: string;
}

export interface KycSession {
  provider: 'smileid' | 'dojah';
  jobId: string;
  sdkToken?: string; // passed to the mobile SDK to capture selfie (+ document)
}

/** Normalised result from any provider. */
export interface KycResult {
  jobId: string;
  livenessPassed: boolean;
  faceMatchScore: number | null;  // selfie vs ID photo (0-100)
  faceTemplateId: string | null;  // stored for face dedupe / bans / photo matching
  duplicateFaceUserId: string | null;
  idFirstName: string | null;
  idLastName: string | null;
  idDateOfBirth: string | null;   // YYYY-MM-DD
  idNationality: string | null;
  rawResultCode: string;
}

@Injectable()
export class SmileIdProvider {
  private readonly logger = new Logger(SmileIdProvider.name);
  private readonly base = process.env.SMILEID_BASE_URL ?? 'https://testapi.smileidentity.com/v1';

  private signature() {
    const timestamp = new Date().toISOString();
    const hmac = createHmac('sha256', process.env.SMILEID_API_KEY ?? '');
    hmac.update(timestamp + (process.env.SMILEID_PARTNER_ID ?? '') + 'sid_request');
    return { timestamp, signature: hmac.digest('base64') };
  }

  verifyCallbackSignature(timestamp: string, signature: string): boolean {
    const hmac = createHmac('sha256', process.env.SMILEID_API_KEY ?? '');
    hmac.update(timestamp + (process.env.SMILEID_PARTNER_ID ?? '') + 'sid_request');
    return hmac.digest('base64') === signature;
  }

  async createSession(req: KycJobRequest): Promise<KycSession> {
    const { timestamp, signature } = this.signature();
    const product = req.isReverification ? 'authentication' : req.route === 'SELFIE_ONLY' ? 'smartselfie' : 'doc_verification';
    const res = await callJson<{ token: string }>(`${this.base}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        partner_id: process.env.SMILEID_PARTNER_ID,
        timestamp,
        signature,
        user_id: req.userId,
        job_id: req.jobId,
        product,
        callback_url: req.callbackUrl,
        id_info: req.documentType
          ? { country: 'NG', id_type: req.documentType === 'NIN' ? 'NIN_V2' : 'PASSPORT', id_number: req.documentNumber }
          : undefined,
      }),
    });
    return { provider: 'smileid', jobId: req.jobId, sdkToken: res.token };
  }

  /** Map a Smile ID callback body to our normalised result. */
  parseCallback(body: Record<string, any>): KycResult {
    const actions = body.Actions ?? {};
    const passed = (v?: string) => v === 'Passed' || v === 'Completed';
    const info = body.FullData ?? body.IDInfo ?? {};
    return {
      jobId: body.PartnerParams?.job_id,
      livenessPassed: passed(actions.Liveness_Check),
      faceMatchScore: body.ConfidenceValue != null ? Number(body.ConfidenceValue) : null,
      faceTemplateId: body.SmileJobID ?? null,
      duplicateFaceUserId: body.DuplicateUserId ?? null,
      idFirstName: info.FirstName ?? info.firstname ?? null,
      idLastName: info.LastName ?? info.surname ?? null,
      idDateOfBirth: info.DOB ?? info.birthdate ?? null,
      idNationality: info.Nationality ?? (body.PartnerParams ? 'NG' : null),
      rawResultCode: String(body.ResultCode ?? ''),
    };
  }
}

/** Backup provider: synchronous NIN / passport lookup + selfie match. */
@Injectable()
export class DojahProvider {
  private readonly base = process.env.DOJAH_BASE_URL ?? 'https://sandbox.dojah.io';
  private headers() {
    return { AppId: process.env.DOJAH_APP_ID ?? '', Authorization: process.env.DOJAH_SECRET_KEY ?? '', 'Content-Type': 'application/json' };
  }

  async verify(req: KycJobRequest & { selfieImageBase64: string; lastName?: string }): Promise<KycResult> {
    let entity: Record<string, any> = {};
    let faceMatchScore: number | null = null;

    if (req.documentType === 'NIN') {
      const res = await callJson<{ entity: any }>(`${this.base}/api/v1/kyc/nin/verify`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ nin: req.documentNumber, selfie_image: req.selfieImageBase64 }),
      });
      entity = res.entity ?? {};
      faceMatchScore = entity.selfie_verification?.confidence_value ?? null;
    } else if (req.documentType === 'NIGERIAN_PASSPORT') {
      const q = new URLSearchParams({ passport_number: req.documentNumber ?? '', surname: req.lastName ?? '' });
      const res = await callJson<{ entity: any }>(`${this.base}/api/v1/kyc/passport?${q}`, { headers: this.headers() });
      entity = res.entity ?? {};
    }

    const liveness = await callJson<{ entity: { liveness?: { liveness_check?: boolean } } }>(
      `${this.base}/api/v1/ml/liveness`,
      { method: 'POST', headers: this.headers(), body: JSON.stringify({ image: req.selfieImageBase64 }) },
    );

    return {
      jobId: req.jobId,
      livenessPassed: !!liveness.entity?.liveness?.liveness_check,
      faceMatchScore,
      faceTemplateId: null,
      duplicateFaceUserId: null,
      idFirstName: entity.first_name ?? null,
      idLastName: entity.last_name ?? entity.surname ?? null,
      idDateOfBirth: entity.date_of_birth ?? null,
      idNationality: req.documentType ? 'NG' : null,
      rawResultCode: 'dojah',
    };
  }
}

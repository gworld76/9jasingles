import { IsIn, IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';

export class StartVerificationDto {
  /** Required for users abroad. Only NIN or Nigerian passport is accepted. */
  @IsOptional() @IsIn(['NIN', 'NIGERIAN_PASSPORT']) documentType?: 'NIN' | 'NIGERIAN_PASSPORT';
  @IsOptional() @Matches(/^[A-Za-z0-9]{8,11}$/) documentNumber?: string;
}

export class DojahSubmitDto {
  @IsUUID() jobId!: string;
  @IsString() @Length(100, 8_000_000) selfieImageBase64!: string;
  @IsOptional() @Matches(/^[A-Za-z0-9]{8,11}$/) documentNumber?: string;
  /** Passport surname, needed for the backup passport lookup. */
  @IsOptional() @IsString() @Length(1, 60) surname?: string;
}

import { IsIn, IsString, Length, Matches } from 'class-validator';

export class RequestOtpDto {
  @Matches(/^\+[1-9]\d{7,14}$/, { message: 'phone must be in international format, e.g. +2348012345678' })
  phone!: string;
  @IsString() @Length(16, 200) deviceFingerprint!: string;
  @IsIn(['ios', 'android']) platform!: 'ios' | 'android';
}

export class VerifyOtpDto extends RequestOtpDto {
  @Matches(/^\d{6}$/) code!: string;
}

export class RefreshDto {
  @IsString() refreshToken!: string;
}

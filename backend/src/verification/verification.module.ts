import { Body, Controller, Get, HttpCode, Module, Post } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { CurrentUser, AuthUser, Public } from '../common/auth.decorators';
import { MODERATION_QUEUE } from '../media/media.constants';
import { DojahSubmitDto, StartVerificationDto } from './verification.dto';
import { VerificationService } from './verification.service';

@Controller('verification')
export class VerificationController {
  constructor(private readonly verification: VerificationService) {}

  @Get('status')
  status(@CurrentUser() user: AuthUser) {
    return this.verification.status(user.id);
  }

  /** +234: liveness selfie only. Abroad: NIN or Nigerian passport + liveness selfie. Also used for fresh selfie re-checks. */
  @Post('start')
  start(@CurrentUser() user: AuthUser, @Body() dto: StartVerificationDto) {
    return this.verification.start(user.id, dto);
  }

  @Post('dojah')
  dojah(@CurrentUser() user: AuthUser, @Body() dto: DojahSubmitDto) {
    return this.verification.submitDojah(user.id, dto.jobId, dto.selfieImageBase64, dto.documentNumber, dto.surname);
  }

  @Public() @Post('webhook/smileid') @HttpCode(200)
  smileWebhook(@Body() body: Record<string, any>) {
    return this.verification.handleSmileCallback(body);
  }
}

@Module({
  imports: [BullModule.registerQueue({ name: MODERATION_QUEUE })],
  controllers: [VerificationController],
  providers: [VerificationService],
  exports: [VerificationService],
})
export class VerificationModule {}

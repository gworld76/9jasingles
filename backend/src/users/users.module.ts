import { Body, Controller, Delete, Get, Global, Module, Param, ParseUUIDPipe, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { CurrentUser, AuthUser } from '../common/auth.decorators';
import { VerifiedGuard } from '../common/guards';
import { ProfileCardService } from './profile-card.service';
import { BasicInfoDto, UpdateProfileDto } from './users.dto';
import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.users.me(user.id);
  }

  @Put('me/basic-info')
  basicInfo(@CurrentUser() user: AuthUser, @Body() dto: BasicInfoDto) {
    return this.users.saveBasicInfo(user.id, dto);
  }

  @Patch('me/profile')
  update(@CurrentUser() user: AuthUser, @Body() dto: UpdateProfileDto) {
    return this.users.updateProfile(user.id, dto);
  }

  @Get('me/onboarding')
  progress(@CurrentUser() user: AuthUser) {
    return this.users.onboardingProgress(user.id);
  }

  @Post('me/complete-onboarding')
  complete(@CurrentUser() user: AuthUser) {
    return this.users.completeOnboarding(user.id);
  }

  @Delete('me')
  remove(@CurrentUser() user: AuthUser) {
    return this.users.deleteAccount(user.id);
  }

  @Get('prompts')
  prompts() {
    return this.users.prompts();
  }

  @UseGuards(VerifiedGuard) @Get(':id')
  profile(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.users.publicProfile(user.id, id);
  }
}

@Global()
@Module({ controllers: [UsersController], providers: [UsersService, ProfileCardService], exports: [UsersService, ProfileCardService] })
export class UsersModule {}

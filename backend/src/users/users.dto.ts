import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsLatitude, IsLongitude, IsOptional,
  IsString, Length, Matches, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';

export class BasicInfoDto {
  @IsString() @Length(2, 60) firstName!: string;
  @IsDateString() dateOfBirth!: string; // must be 18+
  @IsIn(['MALE', 'FEMALE']) gender!: 'MALE' | 'FEMALE';
  @IsIn(['MALE', 'FEMALE']) interestedIn!: 'MALE' | 'FEMALE';
  @IsString() @Length(2, 100) residenceCity!: string;
  @Matches(/^[A-Z]{2}$/) residenceCountry!: string;
  @IsString() @Length(2, 40) stateOfOrigin!: string;
  /** City centre coordinates from the app's city picker. */
  @IsOptional() @IsLatitude() latitude?: number;
  @IsOptional() @IsLongitude() longitude?: number;
}

export class PromptAnswerDto {
  @IsString() promptId!: string;
  @IsString() @Length(1, 200) answer!: string;
}

export class UpdateProfileDto {
  @IsOptional() @IsIn(['MARRIAGE', 'SERIOUS_RELATIONSHIP', 'FRIENDSHIP_FIRST'])
  relationshipGoal?: 'MARRIAGE' | 'SERIOUS_RELATIONSHIP' | 'FRIENDSHIP_FIRST';
  @IsOptional() @IsString() @MaxLength(40) religion?: string;
  @IsOptional() @IsString() @MaxLength(500) bio?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) interests?: string[];
  @IsOptional() @IsArray() @ArrayMinSize(3) @ArrayMaxSize(3) @ValidateNested({ each: true }) @Type(() => PromptAnswerDto)
  prompts?: PromptAnswerDto[];
  @IsOptional() @IsIn(['CITY', 'COUNTRY_ONLY']) locationDisplay?: 'CITY' | 'COUNTRY_ONLY';
  @IsOptional() @IsBoolean() lowDataMode?: boolean;
  @IsOptional() @IsInt() @Min(18) @Max(99) minAgePref?: number;
  @IsOptional() @IsInt() @Min(18) @Max(99) maxAgePref?: number;
  @IsOptional() @IsInt() @Min(1) @Max(20000) maxDistanceKm?: number;
  @IsOptional() @IsIn(['EN', 'PCM', 'YO', 'IG', 'HA']) language?: 'EN' | 'PCM' | 'YO' | 'IG' | 'HA';
}

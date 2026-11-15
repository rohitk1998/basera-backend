import { IsBoolean } from 'class-validator';

export class StoryConsentDto {
  @IsBoolean()
  marketingConsent: boolean;
}

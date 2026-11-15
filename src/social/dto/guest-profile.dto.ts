export type GuestProfileDto = {
  visible: boolean;
  headline: string | null;
  homeCountry: string | null;
  workStatus: string | null;
};

export type GuestCardDto = {
  userId: string;
  firstName: string;
  avatarUrl: string | null;
  headline: string | null;
  homeCountry: string | null;
  workStatus: string | null;
};

export type ListingSummaryDto = { guestsHereCount: number };

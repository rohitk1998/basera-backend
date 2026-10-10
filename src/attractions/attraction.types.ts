/** Kept out of the entity file: entities/index.ts is loaded as a list of entity classes. */
export const ATTRACTION_CATEGORIES = [
  'trek',
  'temple',
  'waterfall',
  'fort',
  'museum',
  'adventure',
  'viewpoint',
  'lake',
] as const;
export type AttractionCategory = (typeof ATTRACTION_CATEGORIES)[number];

export const ATTRACTION_STATUSES = ['draft', 'published', 'hidden'] as const;
export type AttractionStatus = (typeof ATTRACTION_STATUSES)[number];

export const ATTRACTION_DIFFICULTIES = ['easy', 'moderate', 'hard'] as const;
export type AttractionDifficulty = (typeof ATTRACTION_DIFFICULTIES)[number];

import { namesMatch } from './names-match';

describe('namesMatch', () => {
  it.each([
    ['Asha Rao', 'ASHA RAO', true],
    ['Asha  Rao.', 'asha rao', true],
    ['Asha Rao', 'Asha Kumari Rao', true],
    ['A K Rao', 'Asha Kumari Rao', true],
    ['Asha Rao', 'Meera Sharma', false],
    ['Asha Rao', 'Asha Sharma', false],
    ['', 'Asha Rao', false],
  ])('%s vs %s -> %s', (a, b, expected) => expect(namesMatch(a, b)).toBe(expected));
});

import { expect, test } from 'bun:test';
import { EVENTS, validateEvents } from './events';

test('events are valid and in chronological order', () => {
  expect(validateEvents()).toBe(EVENTS);
  const starts = EVENTS.map((e) => Date.parse(e.start));
  expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  expect(() => validateEvents([{ ...EVENTS[0], region: 'tunglið' }])).toThrow('óþekkt svæði');
  expect(() => validateEvents([{ ...EVENTS[0], end: '1990-01-01' }])).toThrow('ógildir tímar');
});

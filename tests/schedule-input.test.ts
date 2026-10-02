import { describe, it, expect } from 'vitest';
import { fromInputValue, inputProblem, suggestedTime, toInputValue } from '../client/src/lib/schedule-input';

describe('date-time field in Vietnam time', () => {
  it('shows a moment as Vietnam wall time', () => {
    expect(toInputValue(new Date('2026-10-03T01:30:00.000Z'))).toBe('2026-10-03T08:30');
    expect(toInputValue(new Date('2026-12-31T18:05:00.000Z'))).toBe('2027-01-01T01:05');
  });

  it('reads the field back to the same moment', () => {
    expect(fromInputValue('2026-10-03T08:30')?.toISOString()).toBe('2026-10-03T01:30:00.000Z');
    expect(fromInputValue('2027-01-01T01:05')?.toISOString()).toBe('2026-12-31T18:05:00.000Z');
  });

  it('rejects an empty or impossible value', () => {
    expect(fromInputValue('')).toBeNull();
    expect(fromInputValue('2026-02-31T08:00')).toBeNull();
    expect(fromInputValue('hôm nay')).toBeNull();
  });

  it('suggests the next full hour that is at least 30 minutes away', () => {
    expect(suggestedTime(new Date('2026-10-03T01:10:00.000Z')).toISOString()).toBe('2026-10-03T02:00:00.000Z');
    expect(suggestedTime(new Date('2026-10-03T01:45:00.000Z')).toISOString()).toBe('2026-10-03T03:00:00.000Z');
  });
});

describe('inputProblem', () => {
  const now = new Date('2026-10-03T01:00:00.000Z'); // 08:00 in Vietnam

  it('asks for a value', () => {
    expect(inputProblem('', now)).toBe('Chọn ngày và giờ đăng.');
  });

  it('needs at least one minute ahead', () => {
    expect(inputProblem('2026-10-03T08:00', now)).toMatch(/ít nhất 1 phút/);
    expect(inputProblem('2026-10-03T07:00', now)).toMatch(/ít nhất 1 phút/);
    expect(inputProblem('2026-10-03T08:01', now)).toBeNull();
  });

  it('allows up to 90 days ahead', () => {
    expect(inputProblem('2027-01-01T08:00', now)).toBeNull();
    expect(inputProblem('2027-01-01T08:01', now)).toMatch(/90 ngày/);
  });
});

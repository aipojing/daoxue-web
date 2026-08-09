import { describe, expect, it } from 'vitest';
import { SUBJECTS, SUBJECT_NAMES, SUBJECT_COLORS, isSubject } from '../src/client/types';

describe('client subjects', () => {
  it('将化学作为第五个完整学科', () => {
    expect(SUBJECTS).toEqual(['math', 'chinese', 'physics', 'english', 'chemistry']);
    expect(SUBJECT_NAMES.chemistry).toBe('化学');
    expect(SUBJECT_COLORS.chemistry).toBe('#7b4f8c');
    expect(isSubject('chemistry')).toBe(true);
  });

  it('继续拒绝未知学科和自学代码', () => {
    expect(isSubject('biology')).toBe(false);
    expect(isSubject('selflearn')).toBe(false);
  });
});

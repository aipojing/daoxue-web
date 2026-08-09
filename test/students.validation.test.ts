import { describe, it, expect } from 'vitest';
import { studentSchema, studentUpdateSchema } from '../src/worker/students/validation';

describe('studentSchema', () => {
  it('接受合法输入', () => {
    const r = studentSchema.safeParse({ name: '小明', grade: '初二' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.textbook).toBe('');
      expect(r.data.color).toBe('#1e5b4a');
    }
  });

  it('拒绝空 name', () => {
    expect(studentSchema.safeParse({ name: '', grade: '初二' }).success).toBe(false);
  });

  it('拒绝超 20 字 name', () => {
    expect(studentSchema.safeParse({ name: '很'.repeat(21), grade: '初二' }).success).toBe(false);
  });

  it('拒绝缺 grade', () => {
    expect(studentSchema.safeParse({ name: '小明' }).success).toBe(false);
  });

  it('拒绝非法颜色', () => {
    expect(studentSchema.safeParse({ name: '小明', grade: '初二', color: 'red;drop' }).success).toBe(false);
  });
});

describe('studentUpdateSchema', () => {
  it('局部更新不会注入创建时的默认值', () => {
    const r = studentUpdateSchema.safeParse({ name: '小红' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual({ name: '小红' });
  });

  it('仍会校验显式提交的字段', () => {
    expect(studentUpdateSchema.safeParse({ color: 'red' }).success).toBe(false);
  });
});

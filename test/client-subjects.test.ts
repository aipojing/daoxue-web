import { describe, expect, it } from 'vitest';
import { SUBJECTS, SUBJECT_NAMES, SUBJECT_COLORS, isSubject, splitRegion } from '../src/client/types';
import * as clientTypes from '../src/client/types';

describe('client subjects', () => {
  it('将历史作为第六个完整学科', () => {
    expect(SUBJECTS).toEqual(['math', 'chinese', 'physics', 'english', 'chemistry', 'history']);
    expect(SUBJECT_NAMES.chemistry).toBe('化学');
    expect(SUBJECT_COLORS.chemistry).toBe('#7b4f8c');
    expect(isSubject('chemistry')).toBe(true);
    expect(SUBJECT_NAMES.history).toBe('历史');
    expect(SUBJECT_COLORS.history).toBe('#8a5a44');
    expect(isSubject('history')).toBe(true);
  });

  it('继续拒绝未知学科和自学代码', () => {
    expect(isSubject('biology')).toBe(false);
    expect(isSubject('selflearn')).toBe(false);
  });

  it('将带行政后缀的地区拆为省份和城市', () => {
    expect(splitRegion('北京市')).toEqual({ province: '北京', city: '' });
    expect(splitRegion('北京市朝阳区')).toEqual({ province: '北京', city: '朝阳区' });
    expect(splitRegion('浙江省杭州市')).toEqual({ province: '浙江', city: '杭州市' });
  });

  it('省份后缀不紧邻省份名时保留城市的市字', () => {
    expect(splitRegion('北京 市辖区')).toEqual({ province: '北京', city: '市辖区' });
  });

  it('按最长后缀拆分民族自治区名称', () => {
    expect(splitRegion('广西壮族自治区南宁市')).toEqual({ province: '广西', city: '南宁市' });
    expect(splitRegion('宁夏回族自治区银川市')).toEqual({ province: '宁夏', city: '银川市' });
    expect(splitRegion('新疆维吾尔自治区乌鲁木齐市')).toEqual({ province: '新疆', city: '乌鲁木齐市' });
  });
});

describe('画像表单关闭保护', () => {
  it('仅填写特别注意事项也应识别为已有内容', () => {
    const hasProfileFormContent = (clientTypes as typeof clientTypes & {
      hasProfileFormContent?: (form: typeof clientTypes.EMPTY_PROFILE_FORM) => boolean;
    }).hasProfileFormContent;

    expect(
      hasProfileFormContent?.({
        ...clientTypes.EMPTY_PROFILE_FORM,
        specialNotes: '容易焦虑，需要多鼓励',
      }),
    ).toBe(true);
    expect(hasProfileFormContent?.(clientTypes.EMPTY_PROFILE_FORM)).toBe(false);
  });

  it('编辑现有画像时只把真实变更识别为 dirty', () => {
    const isProfileFormDirty = (clientTypes as typeof clientTypes & {
      isProfileFormDirty?: (
        current: typeof clientTypes.EMPTY_PROFILE_FORM,
        initial: typeof clientTypes.EMPTY_PROFILE_FORM,
      ) => boolean;
    }).isProfileFormDirty;
    const initial = { ...clientTypes.EMPTY_PROFILE_FORM, specialNotes: '需要多鼓励' };

    expect(isProfileFormDirty?.({ ...initial }, initial)).toBe(false);
    expect(isProfileFormDirty?.({ ...initial, specialNotes: '需要更多鼓励' }, initial)).toBe(true);
  });
});

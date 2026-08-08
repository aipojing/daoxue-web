import { z } from 'zod';

export const studentSchema = z.object({
  name: z
    .string({ required_error: '请输入学生姓名' })
    .trim()
    .min(1, '请输入学生姓名')
    .max(20, '姓名最长 20 字'),
  grade: z
    .string({ required_error: '请选择年级' })
    .trim()
    .min(1, '请选择年级')
    .max(20, '年级不合法'),
  textbook: z.string().trim().max(30, '教材版本最长 30 字').default(''),
  region: z.string().trim().max(30, '地区最长 30 字').default(''),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, '颜色格式不正确')
    .default('#1e5b4a'),
  notes: z.string().trim().max(500, '备注最长 500 字').default(''),
});

export const studentUpdateSchema = studentSchema.partial();

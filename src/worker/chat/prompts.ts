import mathPrompt from '../../../prompts/math.md';
import chinesePrompt from '../../../prompts/chinese.md';
import physicsPrompt from '../../../prompts/physics.md';
import englishPrompt from '../../../prompts/english.md';
import selfLearnProfilingPrompt from '../../../prompts/selflearn-profiling.md';
import selfLearnDailyPrompt from '../../../prompts/selflearn-daily.md';
import type { Subject } from './prompt-builder';

const BASE_PROMPTS: Record<Subject, string> = {
  math: mathPrompt,
  chinese: chinesePrompt,
  physics: physicsPrompt,
  english: englishPrompt,
};

export function getBasePrompt(subject: Subject): string {
  return BASE_PROMPTS[subject];
}

export function getSelfLearnBasePrompt(mode: string): string {
  return mode === 'selflearn-profiling' ? selfLearnProfilingPrompt : selfLearnDailyPrompt;
}

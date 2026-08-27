import { z } from 'zod';
import type { Env } from '../env';
import { normalizeProviderError, ProviderCallError } from './adapters/errors';
import { advanceCourseware } from './generator';

export interface CoursewareQueueMessage {
  coursewareId: number;
}

const messageSchema = z.object({ coursewareId: z.number().int().positive() }).strict();
type Advance = (env: Env, coursewareId: number) => Promise<'done' | 'reenqueue' | 'ignored'>;

export function createCoursewareQueueConsumer(advance: Advance = advanceCourseware) {
  return async function consumeCoursewareQueue(
    batch: MessageBatch<CoursewareQueueMessage>,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    for (const message of batch.messages) {
      const parsed = messageSchema.safeParse(message.body);
      if (!parsed.success) {
        message.ack();
        continue;
      }
      try {
        const result = await advance(env, parsed.data.coursewareId);
        if (result === 'reenqueue') {
          try {
            await env.COURSEWARE_QUEUE.send(parsed.data);
          } catch {
            message.retry({ delaySeconds: 15 });
            continue;
          }
        }
        message.ack();
      } catch (error) {
        if (!(error instanceof ProviderCallError)) {
          message.retry({ delaySeconds: 15 });
          continue;
        }
        const normalized = normalizeProviderError(error);
        if (normalized.retryable) message.retry({ delaySeconds: 15 });
        else message.ack();
      }
    }
  };
}

export const consumeCoursewareQueue = createCoursewareQueueConsumer();

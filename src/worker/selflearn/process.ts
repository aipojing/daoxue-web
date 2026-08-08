import { completeJSON, type ChatMessage } from '../chat/deepseek';
import { beijingToday, beijingDatePlus } from '../chat/quota';
import {
  detectSelfLearnBlocks,
  parseSelfLearnExtraction,
  EXTRACTION_INSTRUCTION,
  type SelfLearnExtraction,
} from './blocks';

async function upsertProfile(db: D1Database, studentId: number, text: string, ready: boolean) {
  await db
    .prepare(
      `INSERT INTO selflearn_profiles (student_id, profile_text, ready, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(student_id) DO UPDATE SET profile_text = excluded.profile_text, ready = excluded.ready, updated_at = datetime('now')`,
    )
    .bind(studentId, text, ready ? 1 : 0)
    .run();
}

async function saveExtraction(
  db: D1Database,
  studentId: number,
  conversationId: number,
  lessonOutput: string | undefined,
  extraction: SelfLearnExtraction,
) {
  for (const kp of extraction.knowledgePoints) {
    await db
      .prepare(
        `INSERT INTO knowledge_points
           (student_id, direction, chain, name, level, evidence, needs_warmup, needs_retest, needs_rebuild, can_network, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(student_id, direction, name) DO UPDATE SET
           chain = excluded.chain, level = excluded.level, evidence = excluded.evidence,
           needs_warmup = excluded.needs_warmup, needs_retest = excluded.needs_retest,
           needs_rebuild = excluded.needs_rebuild, can_network = excluded.can_network,
           updated_at = datetime('now')`,
      )
      .bind(
        studentId,
        kp.direction || extraction.direction,
        kp.chain,
        kp.name,
        kp.level,
        kp.evidence,
        kp.needsWarmup ? 1 : 0,
        kp.needsRetest ? 1 : 0,
        kp.needsRebuild ? 1 : 0,
        kp.canNetwork ? 1 : 0,
      )
      .run();
  }

  if (lessonOutput) {
    await db
      .prepare(
        `INSERT INTO lesson_outputs (student_id, conversation_id, direction, content, next_instruction)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(studentId, conversationId, extraction.direction, lessonOutput, extraction.nextInstruction)
      .run();
  }

  for (const card of extraction.mistakeCards) {
    await db
      .prepare(
        `INSERT INTO mistake_cards
           (student_id, subject, direction, conversation_id, title, knowledge_point, my_answer, key_error,
            error_tags, correct_steps, reminder, retest_question, next_review_date)
         VALUES (?, 'selflearn', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        studentId,
        extraction.direction,
        conversationId,
        card.title,
        card.knowledgePoint,
        card.myAnswer,
        card.keyError,
        JSON.stringify(card.errorTags),
        card.correctSteps,
        card.reminder,
        card.retestQuestion,
        beijingDatePlus(2),
      )
      .run();
  }
}

export async function processSelfLearnMessage(
  db: D1Database,
  apiKey: string,
  studentId: number,
  conversationId: number,
  mode: string,
  content: string,
): Promise<void> {
  try {
    const blocks = detectSelfLearnBlocks(content);

    if (mode === 'selflearn-profiling') {
      if (blocks.profileSummary) {
        await upsertProfile(db, studentId, blocks.profileSummary, true);
      } else if (blocks.profileDraft) {
        await upsertProfile(db, studentId, blocks.profileDraft, false);
      }
      return;
    }

    if (blocks.dailyReport) {
      await db
        .prepare(
          'INSERT INTO daily_reports (student_id, conversation_id, report_date, content) VALUES (?, ?, ?, ?)',
        )
        .bind(studentId, conversationId, beijingToday(), blocks.dailyReport)
        .run();
    }

    if (blocks.lessonOutput || (blocks.mistakeCards && blocks.mistakeCards.length > 0)) {
      const source = [blocks.lessonOutput ?? '', ...(blocks.mistakeCards ?? [])]
        .filter(Boolean)
        .join('\n\n');
      const messages: ChatMessage[] = [
        { role: 'user', content: `${source}\n\n---\n\n${EXTRACTION_INSTRUCTION}` },
      ];
      const raw = await completeJSON(apiKey, { messages });
      const extraction = parseSelfLearnExtraction(raw);
      if (extraction) {
        await saveExtraction(db, studentId, conversationId, blocks.lessonOutput, extraction);
      }
    }
  } catch (e) {
    console.error('selflearn message processing failed (ignored):', e);
  }
}

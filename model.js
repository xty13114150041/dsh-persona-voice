// 纯函数：给人设 agent（B）拼装多轮上下文。不依赖 DSH，便于单测。
//
// 缓存友好：system（人设 + 规则）固定在最前；历史只往后追加、每轮原文完整保留；
// 超过 maxTurns 时成批删掉最早的一半，所以大多数轮次的前缀与上一轮完全相同。
// 简短提醒只附在本轮最后一条消息里，不写进历史，不会破坏前缀。

export const DEFAULT_RULES = `每一轮你会收到用户说的话（<user>），以及执行助手（另一个负责干活的同事）这一轮的原始输出（<executor_output>）。
请用你自己的口吻，把执行结果转述给用户。规则：
1. 只转述，不新增行动。不要提出执行助手没有提出的新操作或新承诺。
2. 代码块、命令、文件路径、数字、版本号、错误信息必须原样保留，不得改写或省略关键结论。
3. 执行结果里的问题、待确认事项、风险提示必须保留。
4. 直接输出给用户看的话，不要写"执行助手说""以下是转述"之类的说明。`;

export const DEFAULT_REMINDER = '保持人设口吻；表情和结尾形式不要和前几轮重复；代码、路径、数字原样保留；只转述，不新增行动。';

/** 成批裁剪的起点：只在跨过一个批次时才变化。 */
export function trimStart(length, maxTurns) {
  if (length <= maxTurns) return 0;
  const chunk = Math.max(1, Math.ceil(maxTurns / 2));
  return Math.ceil((length - maxTurns) / chunk) * chunk;
}

/**
 * @param {object} opts
 * @param {string} opts.persona   人设全文
 * @param {string} [opts.rules]   转述规则
 * @param {string} [opts.reminder] 本轮附加的简短提醒（空则不加）
 * @param {Array<{user:string, raw:string, voice:string}>} opts.history 之前各轮记录（旧→新）
 * @param {{user:string, raw:string}} opts.current 本轮
 * @param {number} [opts.maxTurns=40]  最多带多少轮历史（超出时成批删最早的一半）
 * @param {number} [opts.maxRawChars=12000] 单轮 A 原文截断上限
 */
export function buildRequest({ persona, rules = DEFAULT_RULES, reminder = '', history, current, maxTurns = 40, maxRawChars = 12000 }) {
  const system = `${persona.trim()}\n\n<relay_rules>\n${rules.trim()}\n</relay_rules>`;
  const kept = history.slice(trimStart(history.length, maxTurns));
  const messages = [];
  for (const turn of kept) {
    messages.push({ role: 'user', content: formatTurn(turn.user, turn.raw, maxRawChars) });
    messages.push({ role: 'assistant', content: turn.voice });
  }
  let last = formatTurn(current.user, current.raw, maxRawChars);
  if (reminder.trim()) last += `\n<reminder>${reminder.trim()}</reminder>`;
  messages.push({ role: 'user', content: last });
  return { system, messages };
}

export function formatTurn(user, raw, maxRawChars = 12000) {
  return `<user>\n${(user ?? '').trim()}\n</user>\n<executor_output>\n${clip((raw ?? '').trim(), maxRawChars)}\n</executor_output>`;
}

function clip(text, max) {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  return `${text.slice(0, head)}\n…（中间省略 ${text.length - max} 字）…\n${text.slice(text.length - (max - head))}`;
}

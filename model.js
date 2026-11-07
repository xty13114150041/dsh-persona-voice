// 纯函数：给人设 agent（B）拼装多轮上下文。不依赖 DSH，便于单测。

export const DEFAULT_RULES = `每一轮你会收到用户说的话（<user>），以及执行助手（另一个负责干活的同事）这一轮的原始输出（<executor_output>）。
请用你自己的口吻，把执行结果转述给用户。规则：
1. 只转述，不新增行动。不要提出执行助手没有提出的新操作或新承诺。
2. 代码块、命令、文件路径、数字、版本号、错误信息必须原样保留，不得改写或省略关键结论。
3. 执行结果里的问题、待确认事项、风险提示必须保留。
4. 直接输出给用户看的话，不要写"执行助手说""以下是转述"之类的说明。`;

/**
 * @param {object} opts
 * @param {string} opts.persona   人设全文
 * @param {string} [opts.rules]   转述规则
 * @param {Array<{user:string, raw:string, voice:string}>} opts.history 之前各轮记录（旧→新）
 * @param {{user:string, raw:string}} opts.current 本轮
 * @param {number} [opts.fullTurns=4]  最近多少轮保留 A 的原文
 * @param {number} [opts.maxTurns=40]  最多带多少轮历史
 * @param {number} [opts.maxRawChars=12000] 单轮 A 原文截断上限
 */
export function buildRequest({ persona, rules = DEFAULT_RULES, history, current, fullTurns = 4, maxTurns = 40, maxRawChars = 12000 }) {
  const system = `${persona.trim()}\n\n<relay_rules>\n${rules.trim()}\n</relay_rules>`;
  const kept = history.slice(-maxTurns);
  const messages = [];
  kept.forEach((turn, i) => {
    const withRaw = i >= kept.length - fullTurns;
    messages.push({ role: 'user', content: formatTurn(turn.user, withRaw ? turn.raw : null, maxRawChars) });
    messages.push({ role: 'assistant', content: turn.voice });
  });
  messages.push({ role: 'user', content: formatTurn(current.user, current.raw, maxRawChars) });
  return { system, messages };
}

export function formatTurn(user, raw, maxRawChars = 12000) {
  const parts = [`<user>\n${user.trim()}\n</user>`];
  if (raw != null) parts.push(`<executor_output>\n${clip(raw.trim(), maxRawChars)}\n</executor_output>`);
  else parts.push('<executor_output>（较早轮次，原文已省略）</executor_output>');
  return parts.join('\n');
}

function clip(text, max) {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  return `${text.slice(0, head)}\n…（中间省略 ${text.length - max} 字）…\n${text.slice(text.length - (max - head))}`;
}

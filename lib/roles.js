// dsh-rag — 角色（ADR-0003：角色 = 运行时注册的 agent preset）
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomic } from './library.js';

export const BUILTIN_ROLES = [
  {
    id: 'tutor',
    name: '私人导师',
    emoji: '🎓',
    description: '把概念讲透：先给直觉，再给边界，最后给一个能自己复述的总结。',
    prompt: [
      '你是一位耐心的私人导师，正在陪学生读他自己的知识库笔记。',
      '要求：',
      '- 先确认学生卡在哪一步，再解释；不要一次抛出整章内容。',
      '- 解释顺序：一句话直觉 → 为什么需要它 → 一个具体例子 → 常见误解。',
      '- 引用笔记时，用「原文：」标出你依据的那句话。',
      '- 每轮结尾给学生一个 30 秒能回答的自测问题。',
      '- 学生说"懂了"时，让他用自己的话复述一遍再继续。',
    ].join('\n'),
  },
  {
    id: 'interviewer',
    name: '面试官',
    emoji: '🎤',
    description: '只出题、只追问，不主动给答案；按文档内容出由浅入深的题。',
    prompt: [
      '你是一位严格但公正的技术面试官，面试材料来自候选人自己写的知识库笔记。',
      '要求：',
      '- 一次只问一个问题，等候选人回答后再决定追问还是下一题。',
      '- 题目由浅入深：概念 → 边界条件 → 设计取舍 → 真实故障。',
      '- 候选人答得含糊时，追问"具体是哪个环节"，不要替他补全。',
      '- 不给标准答案；最多给一句方向提示（"想想并发写"）。',
      '- 每 5 题给一次简短评分（掌握/半懂/没懂）并说明依据。',
    ].join('\n'),
  },
  {
    id: 'researcher',
    name: '调研人员',
    emoji: '🔍',
    description: '从库里找出相关篇章，交叉比对，输出带出处的结论和待查清单。',
    prompt: [
      '你是一位严谨的调研人员，负责在用户的知识库里做文献综述。',
      '要求：',
      '- 先用检索工具找出相关篇章，再回答；不要凭记忆编造出处。',
      '- 结论后面必须跟出处（库名 / 文档路径），找不到出处就写"库中未覆盖"。',
      '- 把材料之间的矛盾单独列出来，说明各自前提。',
      '- 输出三块：结论、依据、下一步该补什么资料。',
      '- 不确定的地方标"推测"，不要与事实混在一起。',
    ].join('\n'),
  },
];

export class RoleStore {
  constructor(dataDir) {
    this.dir = dataDir;
    this.file = join(dataDir, 'roles.json');
    this.roles = this.load();
  }

  load() {
    mkdirSync(this.dir, { recursive: true });
    if (existsSync(this.file)) {
      try {
        const data = JSON.parse(readFileSync(this.file, 'utf8'));
        if (Array.isArray(data?.roles) && data.roles.length > 0) return data.roles;
      } catch (error) {
        // 用户手改坏了也先把原文留证：直接覆盖等于把自定义角色永久删掉。
        const backup = `${this.file}.corrupt-${Date.now()}`;
        try {
          renameSync(this.file, backup);
          console.warn(`[dsh-rag] roles.json 解析失败（${error?.message ?? error}），已备份到 ${backup}`);
        } catch {}
      }
    }
    const roles = BUILTIN_ROLES.map((r) => ({ ...r, builtin: true }));
    this.persist(roles);
    return roles;
  }

  persist(roles = this.roles) {
    mkdirSync(this.dir, { recursive: true });
    writeAtomic(this.file, JSON.stringify({ v: 1, roles }, null, 2) + '\n', 0o600);
  }

  list() {
    return this.roles;
  }

  get(id) {
    return this.roles.find((r) => r.id === id) ?? null;
  }

  upsert(role) {
    const id = role.id || 'role-' + Date.now().toString(36);
    const existing = this.get(id);
    const next = {
      id,
      name: role.name?.trim() || existing?.name || '未命名角色',
      emoji: role.emoji || existing?.emoji || '🧩',
      description: role.description ?? existing?.description ?? '',
      prompt: role.prompt ?? existing?.prompt ?? '',
      builtin: existing?.builtin ?? false,
    };
    const index = this.roles.findIndex((r) => r.id === id);
    if (index >= 0) this.roles[index] = next;
    else this.roles.push(next);
    this.persist();
    return next;
  }

  remove(id) {
    const index = this.roles.findIndex((r) => r.id === id);
    if (index < 0) return false;
    if (this.roles[index].builtin) {
      const err = new Error('内置角色不能删除，可以编辑它的提示词');
      err.code = 'EBUILTIN';
      throw err;
    }
    this.roles.splice(index, 1);
    this.persist();
    return true;
  }
}

/** 把角色翻译成 DSH 的 preset 定义。 */
export function presetDefinition(role, order) {
  return {
    id: `rag-${role.id}`,
    name: role.name,
    description: role.description || `知识库角色：${role.name}`,
    order: 700 + order,
    plugins: [
      {
        id: 'persona',
        name: '@deepseek-ai/dsh-persona',
        config: { prefix: role.prompt, complete: false, includeRuntimeContext: true },
      },
    ],
  };
}

/** 注册全部角色 preset；返回 dispose 函数（失败不致命，角色仍可用于前端展示）。 */
export async function registerRolePresets(ctx, roles) {
  const disposers = [];
  const errors = [];
  for (const [index, role] of roles.entries()) {
    try {
      const registered = await ctx.agentPresets.register(presetDefinition(role, index));
      // register 可能返回 disposer，也可能返回 { dispose }。两种都收，否则改名后会重复注册同名 preset。
      const dispose = typeof registered === 'function'
        ? registered
        : typeof registered?.dispose === 'function' ? () => registered.dispose() : null;
      if (dispose) disposers.push(dispose);
    } catch (error) {
      errors.push(`${role.name}: ${error?.message ?? error}`);
    }
  }
  return {
    errors,
    async dispose() {
      for (const fn of disposers) {
        try {
          await fn();
        } catch {}
      }
      disposers.length = 0;
    },
  };
}

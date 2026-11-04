/**
 * dsh-fake-call —— 伪来电：一页"有人打电话给你"的通话界面，对面是 DSH 里的 AI。
 *
 * 做的事情：
 *   - 打开 /fake-call 就是一通"来电"，可以接听/挂断
 *   - 接听后对面用**本机合成的语音**说话（Windows SAPI，零 API key、离线）
 *   - 通话中你打字（或未来接语音识别），对方用一两句口语回你
 *   - 工具 fake_call 能让 agent 主动"打过来"
 *
 * 它**不**做的事（写清楚免得误会）：
 *   - 不会真的拨打你的手机号，也没有运营商通道
 *   - 不录音、不上传音频；声音只在本机合成和播放
 *
 * 业务逻辑在 ./call.js（不依赖 DSH 内部模块，可脱宿主测试），
 * 这里只负责把它接到宿主上：注入 agents / createUserMessage / SessionId，
 * 注册路由与工具。
 */
import Schema from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createCallKit } from './call.js'

export const name = 'dsh-fake-call'
export const inject = ['agents']

export const Config = Schema.object({
  caller: Schema.string().default('小鱼').description('来电显示的名字'),
  voice: Schema.string().default('').description('指定音色（空=自动挑系统里的中文音色）'),
  cwd: Schema.string().description('会话工作目录，默认用宿主进程 cwd'),
  replyTimeoutMs: Schema.number().default(120_000).description('一轮回复的上限'),
  maxRounds: Schema.number().default(40).description('一通电话最多几轮'),
})

export async function apply(ctx, config) {
  const log = (line) => {
    try {
      ctx.logger?.info?.(`[dsh-fake-call] ${line}`)
    } catch {}
    try {
      console.log(`[dsh-fake-call] ${line}`)
    } catch {}
  }

  const webServer = (() => {
    try {
      return ctx.get('webServer')
    } catch {
      return undefined
    }
  })()
  if (!webServer?.register) {
    log('⚠️ webServer 不可用，路由不注册')
    return
  }

  const kit = createCallKit({ agents: ctx.agents, createUserMessage, SessionId, config: config || {}, log })
  ctx.on('session/event', kit.onSessionEvent)

  const disposers = []
  for (const [path, handler] of Object.entries(kit.handlers)) {
    disposers.push(webServer.register({ kind: 'exact', path, handler }))
  }

  let tools
  try {
    tools = ctx.get('tools')
  } catch {
    tools = undefined
  }
  if (tools?.register) {
    tools.register({
      name: 'fake_call',
      description:
        'Ring the fake-call page: puts the /fake-call page into a ringing state so the user can answer a "call" from the assistant. '
        + 'Pass `opening` to have it speak a prepared line verbatim (a briefing, a reminder) instead of improvising a greeting. '
        + 'The page is local-only and the voice is synthesised on this machine — no phone network, no audio leaves the computer.',
      parameters: {
        type: 'object',
        properties: {
          caller: { type: 'string', description: 'Name shown on the incoming-call screen.' },
          opening: { type: 'string', description: 'Optional line to say verbatim right after the user answers (e.g. a short briefing).' },
        },
        required: [],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', properties: { ok: { type: 'boolean' }, report: { type: 'string' } }, required: ['ok', 'report'], additionalProperties: false },
        render: (_a, v) => [{ type: 'text', text: v?.report ?? '' }],
      },
      async execute(args) {
        kit.state.ringing = true
        kit.state.answered = false
        kit.state.rounds = 0
        kit.state.caller = String(args?.caller || config.caller || '小鱼').slice(0, 20)
        kit.state.pendingOpening = String(args?.opening || '').slice(0, 600)
        const tail = kit.state.pendingOpening ? `，接起来会说：「${kit.state.pendingOpening.slice(0, 40)}…」` : ''
        return { ok: true, report: `📞 已在 /fake-call 振铃（来电显示：${kit.state.caller}${tail}）→ http://127.0.0.1:61310/fake-call` }
      },
    })
  }

  ctx.effect(() => () => {
    for (const d of disposers) {
      try {
        d?.()
      } catch {}
    }
  })

  const voices = kit.listVoices()
  log(`✅ /fake-call 已挂载（中文音色：${voices.map((v) => v.name).join(', ') || '未检测到，将用系统默认'}）`)
}

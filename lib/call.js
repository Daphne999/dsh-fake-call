/**
 * call.js —— 伪来电的"业务内核"，不依赖任何 DSH 内部模块。
 *
 * 为什么要拆开：DSH 的 @deepseek-ai/dsh-llm、dsh-session 只在宿主里能解析，
 * 插件仓库本地跑测试时 import 不到。所以这里把所有路由逻辑做成工厂函数，
 * 需要的三样东西（agents / createUserMessage / SessionId）从外面注入：
 *   - 宿主里由 index.js 传真实的
 *   - 测试里传假的
 * 这样"能不能跑"可以在不启动 DSH 的情况下验证。
 */
import fs from 'node:fs'
import { synthesize, listChineseVoices } from './tts.js'

export const PAGE = `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>来电</title>
<style>
  :root{color-scheme:dark;--safe-t:env(safe-area-inset-top,0px);--safe-b:env(safe-area-inset-bottom,0px)}
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  html,body{margin:0;height:100dvh;overflow:hidden;overscroll-behavior:none}
  body{background:radial-gradient(120% 80% at 50% 0%,#1b2a4a 0%,#080c17 60%);
       color:#e8eefc;font:16px/1.5 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
       display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;
       padding:calc(var(--safe-t) + 20px) 20px calc(var(--safe-b) + 20px)}
  .avatar{width:34vw;max-width:150px;min-width:110px;aspect-ratio:1;border-radius:50%;
          background:linear-gradient(160deg,#2b3f68,#16233c);border:2px solid #3b5488;
          display:flex;align-items:center;justify-content:center;font-size:calc(6vw + 16px)}
  .ringing .avatar{animation:pulse 1.6s infinite}
  @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(94,234,212,.35)}70%{box-shadow:0 0 0 28px rgba(94,234,212,0)}100%{box-shadow:0 0 0 0 rgba(94,234,212,0)}}
  .name{font-size:clamp(22px,7vw,30px);font-weight:700;letter-spacing:.5px}
  .sub{color:#8aa0c8;font-size:14px;margin-top:-6px}
  .btns{display:flex;gap:clamp(40px,18vw,72px);margin-top:18px}
  .btn{width:clamp(72px,20vw,88px);height:clamp(72px,20vw,88px);border-radius:50%;border:0;
       font-size:15px;font-weight:700;color:#fff;cursor:pointer;touch-action:manipulation}
  .accept{background:#16a34a;box-shadow:0 8px 24px rgba(22,163,74,.35)}
  .decline{background:#dc2626}
  .hidden{display:none!important}
  .call{width:100%;max-width:520px;display:flex;flex-direction:column;gap:10px;height:100%;justify-content:flex-end}
  .log{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:8px;padding:8px 2px;-webkit-overflow-scrolling:touch}
  .b{max-width:88%;padding:10px 13px;border-radius:15px;white-space:pre-wrap;word-break:break-word;font-size:15px}
  .them{align-self:flex-start;background:#17203a;border:1px solid #233152}
  .me{align-self:flex-end;background:#1f6feb}
  .sys{align-self:center;color:#6f86ae;font-size:12px}
  .bar{display:flex;gap:8px;padding-bottom:6px}
  input{flex:1;min-width:0;padding:13px 14px;border-radius:13px;border:1px solid #233152;
        background:#101a30;color:#e8eefc;font-size:16px}
  button.act{padding:0 16px;border-radius:13px;border:0;background:#1f6feb;color:#fff;font-weight:600;font-size:15px;min-height:44px}
  .hang{background:#dc2626!important}
  .wave{display:flex;gap:3px;align-items:flex-end;height:22px}
  .wave i{width:3px;background:#5eead4;border-radius:2px;animation:eq 1s infinite ease-in-out}
  @keyframes eq{0%,100%{height:5px}50%{height:20px}}
</style></head><body>

<div id="screen" class="ringing">
  <div class="avatar">🐳</div>
  <div class="name" id="caller">__CALLER__</div>
  <div class="sub" id="sub">来电 · 等待接听…</div>
  <div class="btns" id="btns">
    <button class="btn decline" id="decline">挂断</button>
    <button class="btn accept" id="accept">接听</button>
  </div>
</div>

<div id="talk" class="call hidden">
  <div class="log" id="log"></div>
  <div class="bar">
    <div class="wave"><i style="animation-delay:0s"></i><i style="animation-delay:.15s"></i><i style="animation-delay:.3s"></i><i style="animation-delay:.45s"></i></div>
    <input id="q" placeholder="说话（或打字）…" autocomplete="off">
    <button class="act" id="send">说</button>
    <button class="act hang" id="hang">挂断</button>
  </div>
</div>

<script>
  const $ = (id) => document.getElementById(id);
  const state = { timer: null, sec: 0, speaking: null };

  function add(text, cls) {
    const d = document.createElement('div');
    d.className = 'b ' + cls; d.textContent = text;
    $('log').appendChild(d); $('log').scrollTop = $('log').scrollHeight;
  }
  function fmt(s) { return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); }

  async function play(text) {
    if (!text) return;
    try {
      const r = await fetch('/fake-call/tts?text=' + encodeURIComponent(text));
      if (!r.ok) return;
      const blob = await r.blob();
      if (state.speaking) { try { state.speaking.pause(); } catch {} }
      const url = URL.createObjectURL(blob);
      const a = new Audio(url);
      state.speaking = a;
      a.onended = () => URL.revokeObjectURL(url);
      await a.play().catch(() => {});
    } catch {}
  }

  // 手机浏览器要求"音频必须在用户手势里启动"，否则后面 await 完就被拦。
  // 这里在点击的同一拍先播一个静音片段解锁，再走网络请求。
  function unlockAudio() {
    try {
      const a = new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=');
      a.volume = 0.01;
      a.play().catch(() => {});
    } catch {}
    try { state.ctx?.resume?.(); } catch {}
  }

  async function answer() {
    unlockAudio();
    $('screen').classList.add('hidden');
    $('talk').classList.remove('hidden');
    state.timer = setInterval(() => { state.sec++; }, 1000);
    add('已接通', 'sys');
    try {
      const r = await fetch('/fake-call/answer', { method: 'POST' });
      const j = await r.json();
      if (j.error) { add('接通失败：' + j.error, 'sys'); return; }
      add(j.text || '(无声)', 'them');
      play(j.text);
    } catch (e) { add('接通失败：' + e.message, 'sys'); }
  }

  async function say() {
    const box = $('q');
    const text = box.value.trim();
    if (!text) return;
    box.value = '';
    add(text, 'me');
    try {
      const r = await fetch('/fake-call/say', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const j = await r.json();
      if (j.error) { add('出错了：' + j.error, 'sys'); return; }
      add(j.text || '(没说话)', 'them');
      play(j.text);
    } catch (e) { add('出错了：' + e.message, 'sys'); }
  }

  function hangup() {
    if (state.timer) clearInterval(state.timer);
    try { state.speaking?.pause(); } catch {}
    fetch('/fake-call/hangup', { method: 'POST' }).catch(() => {});
    add('通话结束 · ' + fmt(state.sec), 'sys');
    $('talk').classList.add('hidden');
    $('screen').classList.remove('hidden', 'ringing');
    $('btns').classList.add('hidden');
    $('sub').textContent = '通话结束 · ' + fmt(state.sec);
  }

  $('accept').onclick = answer;
  $('decline').onclick = hangup;
  $('hang').onclick = hangup;
  $('send').onclick = say;
  $('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') say(); });

  fetch('/fake-call/state').then((r) => r.json()).then((j) => {
    if (j.caller) $('caller').textContent = j.caller;
    if (!j.ringing) { $('screen').classList.remove('ringing'); $('sub').textContent = '没有来电（用 fake_call 工具触发）'; }
  }).catch(() => {});

  // 轮询：页面一直开着，也能接到"你几分钟没回我"打过来的电话
  let wasRinging = false;
  setInterval(async () => {
    if (state.timer) return; // 通话中不轮询
    try {
      const j = await (await fetch('/fake-call/state')).json();
      if (j.caller) $('caller').textContent = j.caller;
      if (j.ringing && !wasRinging) {
        wasRinging = true;
        $('screen').classList.remove('hidden');
        $('screen').classList.add('ringing');
        $('btns').classList.remove('hidden');
        $('sub').textContent = '来电 · 等待接听…';
      } else if (!j.ringing) {
        wasRinging = false;
      }
    } catch {}
  }, 2000);
</script></body></html>`

/** 只取一句话：太长就截断，免得"来电"里念半天 */
export function oneLine(s, max = 120) {
  const t = String(s || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*#`>_~]/g, '')
    .replace(/\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!t) return ''
  const m = t.match(new RegExp('^[^。！？!?]{1,' + max + '}[。！？!?]?'))
  return (m ? m[0] : t.slice(0, max)).trim()
}

/**
 * @param {object} deps
 * @param {any} deps.agents             ctx.agents
 * @param {(o:any)=>any} deps.createUserMessage
 * @param {(s:string)=>any} deps.SessionId
 * @param {object} deps.config
 * @param {(s:string)=>void} deps.log
 */
export function createCallKit({ agents, createUserMessage, SessionId, config = {}, log = () => {} }) {
  const caller = config.caller || 'DeepSeek'
  const sessionId = SessionId('dsh-fake-call-default')
  const state = { ringing: false, answered: false, rounds: 0, caller, pendingOpening: '' }

  // ── "没回就催一下"：发出去的消息若干秒没人理，就自动振铃 ──
  const nudges = new Set()
  let lastUserAt = Date.now()
  let nudgedCount = 0

  /** 用户说了一句话 → 取消所有待触发的催促 */
  function noteUserActivity() {
    lastUserAt = Date.now()
    for (const t of nudges) clearTimeout(t)
    nudges.clear()
  }

  /**
   * 安排一次"没人理就打电话"。
   * @param {{waitSeconds?:number, opening?:string, caller?:string, onFire?:(info:object)=>void}} opts
   */
  function armNudge(opts = {}) {
    const waitMs = Math.max(1, Number(opts.waitSeconds ?? 300)) * 1000
    const fired = { value: false }
    const timer = setTimeout(() => {
      nudges.delete(timer)
      fired.value = true
      nudgedCount++
      state.ringing = true
      state.answered = false
      state.rounds = 0
      state.caller = String(opts.caller || caller).slice(0, 20)
      state.pendingOpening = String(opts.opening || '').slice(0, 600)
      log(`⏰ ${Math.round(waitMs / 1000)} 秒没人回，自动振铃（第 ${nudgedCount} 次）`)
      try {
        opts.onFire?.({ caller: state.caller, opening: state.pendingOpening, url: '/fake-call' })
      } catch {}
    }, waitMs)
    nudges.add(timer)
    return {
      waitSeconds: Math.round(waitMs / 1000),
      /** 测试用：立刻触发 */
      fireNow() {
        clearTimeout(timer)
        nudges.delete(timer)
        fired.value = true
        nudgedCount++
        state.ringing = true
        state.answered = false
        state.rounds = 0
        state.caller = String(opts.caller || caller).slice(0, 20)
        state.pendingOpening = String(opts.opening || '').slice(0, 600)
        try {
          opts.onFire?.({ caller: state.caller, opening: state.pendingOpening, url: '/fake-call' })
        } catch {}
      },
      cancel() {
        clearTimeout(timer)
        nudges.delete(timer)
      },
      get fired() {
        return fired.value
      },
    }
  }
  let agentEntry = null
  let awaiting = null

  function onSessionEvent(session, raw) {
    if (!raw) return
    // 用户开口了 → 取消"没回就催"的闹钟（要在 awaiting 判断之前）
    if (raw.type === 'user/message') noteUserActivity()
    if (!awaiting) return
    if (session?.header?.id !== awaiting.sessionId) return
    if (raw.type === 'assistant/message') {
      const blocks = raw.data?.message?.content
      if (Array.isArray(blocks)) for (const b of blocks) if (b?.type === 'text' && b.text) awaiting.texts.push(b.text)
      return
    }
    if (raw.type === 'turn/end') {
      const entry = awaiting
      awaiting = null
      entry.finish(entry.texts.join('\n').trim())
    }
  }

  async function getAgent() {
    if (agentEntry?.agent) return agentEntry.agent
    const live = agents.get(sessionId)
    if (live) {
      agentEntry = { agent: live }
      return live
    }
    try {
      const resumed = await agents.resume({ resumeSessionId: sessionId })
      agentEntry = { agent: resumed.agent }
      return resumed.agent
    } catch {
      const created = await agents.create({ sessionId, meta: { ...(config.cwd ? { cwd: config.cwd } : {}) } })
      agentEntry = { agent: created.agent }
      return created.agent
    }
  }

  function ask(agent, text) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (awaiting) {
          const e = awaiting
          awaiting = null
          e.finish('')
        }
      }, config.replyTimeoutMs ?? 120_000)
      awaiting = { sessionId, texts: [], finish: (t) => { clearTimeout(timer); resolve(t) } }
      try {
        agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      } catch {
        const e = awaiting
        awaiting = null
        e.finish('')
      }
    })
  }

  const send = (res, code, type, body) => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' })
    res.end(body)
  }
  const json = (res, code, obj) => send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj))
  const readBody = async (req) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    } catch {
      return {}
    }
  }

  const handlers = {
    '/fake-call': (req, res) => send(res, 200, 'text/html; charset=utf-8', PAGE.replace('__CALLER__', String(caller).replace(/[<>&]/g, ''))),

    '/fake-call/state': (req, res) => json(res, 200, { ringing: state.ringing, answered: state.answered, caller: state.caller }),

    '/fake-call/ring': async (req, res) => {
      const body = req.method === 'POST' ? await readBody(req) : {}
      state.ringing = true
      state.answered = false
      state.rounds = 0
      state.caller = String(body.caller || caller).slice(0, 20)
      // 带简报的来电：接起来先念这段，不走模型（保证到点一定说得出来）
      state.pendingOpening = String(body.opening || '').slice(0, 600)
      log(`📞 来电：${state.caller}${state.pendingOpening ? '（带简报）' : ''}`)
      json(res, 200, { ok: true, ringing: true, caller: state.caller, opening: state.pendingOpening || undefined, url: '/fake-call' })
    },

    '/fake-call/answer': async (req, res) => {
      state.ringing = false
      state.answered = true
      // 有预置简报就直接念，别让模型现编（日程提醒这种必须说准）
      if (state.pendingOpening) {
        const line = state.pendingOpening
        state.pendingOpening = ''
        return json(res, 200, { text: oneLine(line, 200) || line })
      }
      try {
        const agent = await getAgent()
        const reply = await ask(agent, '（这是一通语音通话接通的一瞬间。请用一句话打招呼，口语，不超过 30 字，不要解释。）')
        json(res, 200, { text: oneLine(reply, 40) || '喂，是我。' })
      } catch {
        json(res, 200, { text: '喂，是我。' })
      }
    },

    '/fake-call/say': async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { error: 'POST only' })
      const body = await readBody(req)
      const text = String(body.text || '').trim().slice(0, 500)
      if (!text) return json(res, 400, { error: 'text 为空' })
      state.rounds++
      const ended = state.rounds >= (config.maxRounds || 40)
      try {
        const agent = await getAgent()
        const reply = await ask(agent, `（语音通话中。对方刚说：「${text}」。请像打电话一样用一两句口语回应，不超过 60 字；不要列点、不要解释、不要问"还有什么可以帮你"。）`)
        json(res, 200, { text: oneLine(reply, 80) || '嗯，我在。', ended })
      } catch (err) {
        json(res, 500, { error: err instanceof Error ? err.message : String(err) })
      }
    },

    '/fake-call/hangup': (req, res) => {
      state.answered = false
      state.ringing = false
      log('📴 挂断')
      json(res, 200, { ok: true })
    },

    '/fake-call/tts': async (req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const text = (url.searchParams.get('text') || '').slice(0, 600)
      if (!text) return json(res, 400, { error: 'text 为空' })
      try {
        const file = await synthesize(text, { voice: config.voice || undefined })
        send(res, 200, 'audio/wav', fs.readFileSync(file))
      } catch (err) {
        json(res, 500, { error: err instanceof Error ? err.message : String(err) })
      }
    },
  }

  return { handlers, state, onSessionEvent, armNudge, noteUserActivity, listVoices: listChineseVoices, oneLine }
}

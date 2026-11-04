/**
 * smoke.mjs —— 脱离 DSH 直接验证业务内核（lib/call.js）。
 *
 * 通过注入假的 agents / createUserMessage / SessionId，
 * 把 7 条路由逐个调一遍，其中 /fake-call/tts 会真的合成一段中文 wav。
 */
import { createCallKit, oneLine } from '../lib/call.js';

const fakeAgent = {
  followup: () => {},
};

const kit = createCallKit({
  agents: {
    get: () => null,
    resume: async () => {
      throw new Error('no session');
    },
    create: async () => ({ agent: fakeAgent }),
  },
  createUserMessage: (o) => o,
  SessionId: (s) => s,
  config: { caller: '小鱼', replyTimeoutMs: 2000 },
  log: () => {},
});

const need = ['/fake-call', '/fake-call/state', '/fake-call/ring', '/fake-call/answer', '/fake-call/say', '/fake-call/hangup', '/fake-call/tts'];
const missing = need.filter((p) => !kit.handlers[p]);
if (missing.length) {
  console.error('❌ 缺少路由:', missing.join(', '));
  process.exit(1);
}
console.log(`✅ ${need.length} 条路由齐全`);

function fakeRes() {
  const out = { code: 0, headers: {}, body: null };
  return {
    writeHead: (code, headers) => {
      out.code = code;
      out.headers = headers;
    },
    end: (body) => {
      out.body = body;
    },
    get result() {
      return out;
    },
  };
}
const postReq = (obj = {}) => ({
  method: 'POST',
  url: '/',
  headers: {},
  [Symbol.asyncIterator]: async function* () {
    yield Buffer.from(JSON.stringify(obj));
  },
});

// 1. 页面
{
  const res = fakeRes();
  await kit.handlers['/fake-call']({ method: 'GET', url: '/fake-call', headers: {} }, res);
  const html = String(res.result.body);
  if (res.result.code !== 200 || !html.includes('接听') || !html.includes('小鱼')) {
    console.error('❌ 页面异常');
    process.exit(1);
  }
  console.log('✅ 页面正常（含接听按钮、来电显示名）');
}

// 2. 振铃 → state
{
  const r1 = fakeRes();
  await kit.handlers['/fake-call/ring'](postReq({ caller: '小鱼' }), r1);
  if (JSON.parse(r1.result.body).ringing !== true) {
    console.error('❌ 振铃失败');
    process.exit(1);
  }
  const r2 = fakeRes();
  await kit.handlers['/fake-call/state']({ method: 'GET', url: '/fake-call/state', headers: {} }, r2);
  const st = JSON.parse(r2.result.body);
  if (!st.ringing || st.caller !== '小鱼') {
    console.error('❌ state 不对:', r2.result.body);
    process.exit(1);
  }
  console.log('✅ 振铃 → state 正确');
}

// 3. 接听（agent 永远不回复 → 应回落到默认招呼语，不挂起）
{
  const res = fakeRes();
  await kit.handlers['/fake-call/answer'](postReq(), res);
  const j = JSON.parse(res.result.body);
  if (res.result.code !== 200 || typeof j.text !== 'string' || !j.text) {
    console.error('❌ 接听无兜底:', res.result.body);
    process.exit(1);
  }
  console.log(`✅ 接听有兜底开场白：「${j.text}」`);
}

// 4. 挂断
{
  const res = fakeRes();
  await kit.handlers['/fake-call/hangup'](postReq(), res);
  if (JSON.parse(res.result.body).ok !== true || kit.state.answered !== false) {
    console.error('❌ 挂断异常');
    process.exit(1);
  }
  console.log('✅ 挂断正常');
}

// 5. 空文本
{
  const res = fakeRes();
  await kit.handlers['/fake-call/say'](postReq({ text: '  ' }), res);
  if (res.result.code !== 400) {
    console.error('❌ 空文本未拒绝');
    process.exit(1);
  }
  console.log('✅ 空文本被拒绝');
}

// 6. 真 TTS
{
  const res = fakeRes();
  await kit.handlers['/fake-call/tts']({ method: 'GET', url: '/fake-call/tts?text=' + encodeURIComponent('喂，是我，听得见吗'), headers: {} }, res);
  const buf = res.result.body;
  const ok = res.result.code === 200 && Buffer.isBuffer(buf) && buf.length > 5000 && buf.subarray(0, 4).toString('ascii') === 'RIFF';
  if (!ok) {
    console.error('❌ TTS 异常: code=' + res.result.code + ' len=' + (Buffer.isBuffer(buf) ? buf.length : typeof buf));
    process.exit(1);
  }
  console.log(`✅ TTS 真实合成成功（${(buf.length / 1024).toFixed(0)} KB wav）`);
}

// 7. oneLine 截断
{
  const long = '这是一段很长的回复。'.repeat(20);
  const t = oneLine(long, 60);
  if (!t || t.length > 62) {
    console.error('❌ oneLine 没截断:', t.length);
    process.exit(1);
  }
  console.log(`✅ oneLine 截断正常（${t.length} 字）`);
}

console.log('\n✅ 全部通过');

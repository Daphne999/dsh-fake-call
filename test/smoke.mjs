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
  config: { caller: 'DeepSeek', replyTimeoutMs: 2000 },
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
  if (res.result.code !== 200 || !html.includes('接听') || !html.includes('DeepSeek')) {
    console.error('❌ 页面异常');
    process.exit(1);
  }
  console.log('✅ 页面正常（含接听按钮、来电显示名）');
}

// 2. 振铃 → state
{
  const r1 = fakeRes();
  await kit.handlers['/fake-call/ring'](postReq({ caller: 'DeepSeek' }), r1);
  if (JSON.parse(r1.result.body).ringing !== true) {
    console.error('❌ 振铃失败');
    process.exit(1);
  }
  const r2 = fakeRes();
  await kit.handlers['/fake-call/state']({ method: 'GET', url: '/fake-call/state', headers: {} }, r2);
  const st = JSON.parse(r2.result.body);
  if (!st.ringing || st.caller !== 'DeepSeek') {
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

// 8. 带简报的来电：接起来必须原样念简报，不能被模型改写
{
  const brief = '十点半和设计团队的会，改到两点了。';
  const ring = fakeRes();
  await kit.handlers['/fake-call/ring'](postReq({ caller: 'DeepSeek', opening: brief }), ring);
  if (JSON.parse(ring.result.body).opening !== brief) {
    console.error('❌ 简报没存进 state');
    process.exit(1);
  }
  const ans = fakeRes();
  await kit.handlers['/fake-call/answer'](postReq(), ans);
  const j = JSON.parse(ans.result.body);
  if (j.text !== brief) {
    console.error('❌ 接听没有原样念简报:', j.text);
    process.exit(1);
  }
  // 念完就清空，下一通不会重复念
  if (kit.state.pendingOpening !== '') {
    console.error('❌ 简报没被清空');
    process.exit(1);
  }
  console.log('✅ 带简报来电：原样念出且只念一次');
}

// 9. "没人理就打电话"：布下闹钟 → 用户说话就取消
{
  const n = kit.armNudge({ waitSeconds: 1, caller: 'DeepSeek', opening: '在吗' });
  if (n.waitSeconds !== 1) {
    console.error('❌ nudge 参数不对');
    process.exit(1);
  }
  kit.noteUserActivity(); // 用户回话了
  await new Promise((r) => setTimeout(r, 1200));
  if (kit.state.ringing) {
    console.error('❌ 用户已回复，不该振铃');
    process.exit(1);
  }
  console.log('✅ 用户先回话 → 催促被取消');
}

// 10. 没人理 → 真的振铃（用 fireNow 直接触发，避免等真实时间）
{
  let fired = null;
  const n = kit.armNudge({
    waitSeconds: 300,
    caller: 'DeepSeek',
    opening: '任务跑完了',
    onFire: (info) => {
      fired = info;
    },
  });
  n.fireNow();
  if (!kit.state.ringing || kit.state.caller !== 'DeepSeek' || kit.state.pendingOpening !== '任务跑完了') {
    console.error('❌ 触发后状态不对');
    process.exit(1);
  }
  if (!fired || fired.opening !== '任务跑完了') {
    console.error('❌ onFire 没被调用');
    process.exit(1);
  }
  const res = fakeRes();
  await kit.handlers['/fake-call/answer'](postReq(), res);
  const j = JSON.parse(res.result.body);
  if (j.text !== '任务跑完了') {
    console.error('❌ 自动打来后没念简报:', j.text);
    process.exit(1);
  }
  console.log('✅ 没人理 → 自动振铃并念简报');
}

console.log('\n✅ 全部通过');

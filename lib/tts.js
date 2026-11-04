/**
 * tts.js —— 用 Windows 自带的语音合成（SAPI）出 wav，零 key、纯离线。
 *
 * 为什么不用云端 TTS：这个插件的卖点就是"不依赖任何 API key 也能出声"。
 * 代价是音色只有系统里装的几个（中文一般是 Microsoft Huihui）。
 *
 * 实现要点：
 *   - 每次合成都会拉起一次 powershell，约 1 秒；文本做 md5 缓存，重复句子不再合成
 *   - wav 落在系统临时目录下的 dsh-fake-call/ 里，交给本插件的 /fake-call/tts 路由回放
 *   - 文本会经单引号转义后拼进 PowerShell 脚本，避免引号注入
 */
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CACHE_DIR = path.join(os.tmpdir(), 'dsh-fake-call');

/** 列出系统里可用的中文音色（同步，只在启动时跑一次） */
export function listChineseVoices() {
  const ps = `
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.GetInstalledVoices() | ForEach-Object {
  $i = $_.VoiceInfo
  if ($i.Culture.Name -like 'zh*') { "$($i.Name)|$($i.Culture.Name)" }
}
$s.Dispose()
`;
  try {
    const out = execFileSyncPowerShell(ps, 15000);
    return out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [name, culture] = l.split('|');
        return { name, culture };
      });
  } catch {
    return [];
  }
}

function execFileSyncPowerShell(script, timeout = 30000) {
  return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout,
    windowsHide: true,
  });
}

const q = (s) => String(s).replace(/'/g, "''");

/**
 * 合成一段话，返回 wav 的绝对路径（已缓存则直接返回）。
 * @param {string} text
 * @param {{voice?: string, rate?: number}} [opts]
 */
export function synthesize(text, opts = {}) {
  const clean = String(text || '').trim().slice(0, 600);
  if (!clean) throw new Error('tts: 文本为空');
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const hash = createHash('md5').update(`${opts.voice || ''}|${opts.rate ?? 0}|${clean}`).digest('hex').slice(0, 16);
  const file = path.join(CACHE_DIR, `${hash}.wav`);
  if (fs.existsSync(file) && fs.statSync(file).size > 1000) return file;

  const rate = Number.isFinite(opts.rate) ? Math.max(-10, Math.min(10, opts.rate)) : 0;
  const ps = `
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
${opts.voice ? `try { $s.SelectVoice('${q(opts.voice)}') } catch {}` : `$cn = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like 'zh*' } | Select-Object -First 1; if ($cn) { $s.SelectVoice($cn.VoiceInfo.Name) }`}
$s.Rate = ${rate}
$s.SetOutputToWaveFile('${q(file)}')
$s.Speak('${q(clean)}')
$s.Dispose()
`;
  return new Promise((resolve, reject) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 60000, windowsHide: true }, (err, _stdout, stderr) => {
      if (err) return reject(new Error(`tts 合成失败: ${String(stderr || err.message).slice(0, 200)}`));
      if (!fs.existsSync(file) || fs.statSync(file).size < 1000) return reject(new Error('tts 合成失败: 产物为空'));
      resolve(file);
    });
  });
}

export function cacheDir() {
  return CACHE_DIR;
}

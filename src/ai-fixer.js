// AI-powered auto-fix: analyzes relay failures and runs the appropriate fix command.
// Supports OpenAI (gpt-4o-mini) and Claude (claude-haiku-4-5) providers.

// BUG FIX (2026-09-22): saglayici isteklerinde hicbir zaman asimi yoktu. Ag ya da
// saglayici takilirsa istek suresiz asili kalir; auto-fix akisi o relay icin kilitlenir
// (autoFixInProgress set'i temizlenmez) ve o kutu bir daha hic denenmez.
const AI_TIMEOUT_MS = 30000;

async function fetchWithTimeout(url, opts) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), AI_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } catch (e) {
    if (e && e.name === 'AbortError') {
      throw new Error(`AI provider did not answer within ${AI_TIMEOUT_MS / 1000}s`);
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

async function callOpenAI(apiKey, userPrompt) {
  const res = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 500,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OpenAI API ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
}

async function callClaude(apiKey, userPrompt) {
  const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 500,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Claude API ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return (data.content && data.content[0] && data.content[0].text) || '';
}

// Komut adları hem Türkçe hem İngilizce olabilir (varsayılan liste İngilizce).
// Tek dile bağlı regex kullanılırsa fallback hiçbir zaman eşleşmez ve
// AI API hatası aldığında auto-fix hiçbir komut çalıştırmaz.
const RESTART_RELAY = /relay yeniden baslatma|relay zorunlu yenileme|restart.*relay|relay.*restart/i;
const RESTART_SSH = /ssh enable ve restart|ssh servisi yeniden baslatma|restart.*ssh|ssh.*restart/i;

// Salt okunur komutlarin ad kaliplari. Kullanicinin listesi degisebilir; ad
// kalibiyla ariyoruz ki liste yeniden siralansa da bulunsun.
const CHECK_STATUS = /check.*status|service status|servis durum/i;
const SHOW_LOGS    = /log lines|last \d+ log|son \d+ .*log|journalctl|loglar/i;
const DISK_USAGE   = /disk usage|disk kullan|disk alan/i;
const RAM_LOAD     = /ram and load|ram ve yuk|memory.*load|bellek.*yuk/i;
const REBOOT_CHECK = /reboot required|reboot gerek|yeniden baslatma gerek/i;
const GUARD_FIX    = /guard path.*duzelt|enforced.*subnet|tam otomatik relay/i;

// Hata imzasi -> hangi komut. SIRA ONEMLI, en ozel kalip once.
//
// Tasarim: anahtar yokken (ya da API dustugunde) dogru davranis "tahminle bir sey
// degistir" DEGIL, "operatorun karar verebilecegi kaniti topla". Bu yuzden girdilerin
// cogu SALT OKUNUR bir komuta gidiyor; yalnizca sebebi kesin bilinen uc imza servis
// yeniden baslatiyor. Her kural birden fazla aday sayar: ilki kullanicinin listesinde
// yoksa sonraki denenir, hicbiri yoksa genel taniya duser.
//
// ONCEKI HATA: fail2ban dali listede olmayan tek bir komuta bakiyordu ve undefined
// donuyordu — fail2ban hatasinda auto-fix HICBIR SEY yapmiyordu, log bile toplamiyordu.
const FALLBACK_RULES = [
  { kind: 'disk',    when: /no space left|disk full|write error|read-only file system|input\/output error|ext4-fs error|quota exceeded|disk dolu/i,
    pick: [DISK_USAGE, SHOW_LOGS] },
  { kind: 'memory',  when: /out of memory|oom-kill|oom killer|cannot allocate memory|cannot fork|resource temporarily unavailable|bellek yetersiz/i,
    pick: [RAM_LOAD, SHOW_LOGS] },
  { kind: 'reboot',  when: /reboot-required|reboot required|system restart required|kernel.*upgrad|yeniden baslatma gerekiyor/i,
    pick: [REBOOT_CHECK, SHOW_LOGS] },
  { kind: 'pkglock', when: /could not get lock|dpkg.*lock|apt.*lock|unattended-upgr|frontend is locked/i,
    pick: [SHOW_LOGS, CHECK_STATUS] },
  { kind: 'ban',     when: /fail2ban|banned|ban list|jail/i,
    pick: [CHECK_STATUS, SHOW_LOGS] },
  { kind: 'clock',   when: /clock skew|time skew|not yet valid|certificate.*expired|saat kaymas/i,
    pick: [SHOW_LOGS, CHECK_STATUS] },
  { kind: 'guard',   when: /dashboard_running=false|running=false|relay agda gorunmuyor|guard.*path|path.*restriction|enforce.*subnet|port.*missing|relay port/i,
    pick: [GUARD_FIX, RESTART_RELAY] },
  { kind: 'anon',    when: /anon servisi (inactive|failed) oldu|inactive|deactivated|failed to bind|relay offline|anon.*failed|failed.*anon/i,
    pick: [RESTART_RELAY, CHECK_STATUS] },
  { kind: 'ssh',     when: /ssh master|ssh cevap vermiyor|ssh baglantisi|connection refused|permission denied|host key|banner|handshake|sshd|port 22/i,
    pick: [RESTART_SSH, CHECK_STATUS] },
];

function pickFallbackCommand(errorMsg, autoFixCommands) {
  const msg = String(errorMsg || '');
  if (!msg.trim()) return null;
  const list = Array.isArray(autoFixCommands) ? autoFixCommands : [];
  const byName = (re) => list.find(c => re.test(String(c.name || '')));

  for (const rule of FALLBACK_RULES) {
    if (!rule.when.test(msg)) continue;
    for (const re of rule.pick) {
      const hit = byName(re);
      if (hit) return hit;
    }
    break;   // kural esletti ama tercihleri yapilandirilmamis -> genel taniya dus
  }
  // Kutuya ulasilabiliyor ama sebep taninmiyor: en azindan kaniti topla.
  // (Ulasilamayan kutular buraya hic gelmez, classifyAutoFixability once eler.)
  return byName(SHOW_LOGS) || byName(CHECK_STATUS) || null;
}


// Main entry point. Returns { ok, action, commandName?, output?, reason, error? }
// action is 'ran' | 'none' | undefined (on error)
async function analyzeAndFix({ server, errorMsg, recentLogs, cfg, runCommandFn }) {
  const { openaiApiKey, claudeApiKey, aiProvider, autoFixCommands = [] } = cfg;
  const useClaude = aiProvider === 'claude' || (!openaiApiKey && claudeApiKey);
  const apiKey = useClaude ? (claudeApiKey || cfg.aiApiKey) : (openaiApiKey || cfg.aiApiKey || claudeApiKey);

  if (!autoFixCommands.length) {
    return { ok: false, error: 'Command list is empty. Add commands under Settings > AI Auto-Fix.' };
  }

  // No API key: fall back to rule-based matching instead of doing nothing.
  // Auto-Fix is a paid feature, so it has to work out of the box; the AI path
  // is the better version of it, not the only version. Same fallback the API
  // failure paths below use.
  if (!apiKey || !apiKey.trim()) {
    const fallbackCmd = pickFallbackCommand(errorMsg, autoFixCommands);
    if (!fallbackCmd) {
      return { ok: true, action: 'none', reason: 'No rule matched this error. Add an AI API key under Settings > AI Auto-Fix for log-based diagnosis.' };
    }
    const runResult = await runCommandFn(server.name, fallbackCmd.command);
    return {
      ok: runResult.ok,
      action: 'ran',
      commandName: fallbackCmd.name,
      output: runResult.output || '',
      reason: `Rule-based fix for this error type (${fallbackCmd.name}). Add an AI API key for log-based root-cause analysis.`,
      error: runResult.ok ? undefined : runResult.error,
    };
  }

  const commandList = autoFixCommands
    .map(c => `${c.id}. ${c.name}\n   ${c.command}`)
    .join('\n\n');
  const logText = (recentLogs || []).join('\n').slice(-4000) || '(log alinamadi)';

  const errorLower = String(errorMsg || '').toLowerCase();
  const serviceIsDown = /inactive|failed|dead|stopped|anon.*durdu|offline/.test(errorLower);
  const dashboardIssue = /running=false|relay agda gorunmuyor|guard.*path/.test(errorLower);

  // Log analizi — AI'nin gorecegi ozet
  const hasCoreDump = /sigabrt|core.dump|munmap_chunk|abort/i.test(logText);
  const hasBandwidthError = /bandwidthrate|bandwidthburst/i.test(logText);
  const hasBindError = /address already in use|bind.*failed/i.test(logText);
  const hasGuardPath = /guards excluded|path restriction|enforceDistinctSubnets/i.test(logText);
  const hasPermError = /permission denied|operation not permitted/i.test(logText);
  const hasDiskFull = /no space left|disk full|enospc/i.test(logText);
  const hasConfigError = /configuration error|invalid option|unknown keyword/i.test(logText);

  const logHints = [
    hasCoreDump && 'LOG: SIGABRT/core dump detected',
    hasBandwidthError && 'LOG: BandwidthRate/BandwidthBurst error present',
    hasBindError && 'LOG: "Address already in use" - port conflict',
    hasGuardPath && 'LOG: Guard path restriction error',
    hasPermError && 'LOG: Permission denied error',
    hasDiskFull && 'LOG: Disk full (no space left)',
    hasConfigError && 'LOG: Configuration error',
  ].filter(Boolean).join('\n');

  const prompt = `You are a Linux server administration assistant monitoring Anyone Network relay servers.
Reply with JSON only, nothing else.

Server: ${server.name}
Reported error: ${String(errorMsg || '').slice(0, 500)}
${logHints ? `\nLog analysis summary:\n${logHints}` : ''}

Last 100 log lines (READ CAREFULLY — find the root cause here):
${logText}

DECISION RULES (follow in priority order):
1. READ THE LOGS FIRST — identify the cause from the log; do not restart blindly.
2. If the disk is full: choose the "disk cleanup" command.
3. If you see SIGABRT/core dump + BandwidthRate: choose remove BandwidthRate lines + restart.
4. If "Address already in use": choose stop process + restart.
5. If Guard path restriction: choose a diagnostic command, not a direct restart.
6. If a configuration error: first choose a log/status check command.
${dashboardIssue ? '7. DASHBOARD ISSUE: the relay is not visible on the network — choose a diagnostic/log command first, not a direct restart.' : ''}
${serviceIsDown && !hasConfigError && !hasDiskFull && !hasGuardPath ? '8. Service is down and the log shows no specific error — choose the restart command.' : ''}
- Choose ONLY the id of a command that ACTUALLY EXISTS in the list below; never invent a command name.
- If the logs show a clear cause, choose the matching command; otherwise choose the log command.
- Only choose a command if intervention is genuinely needed; if unsure, choose the log command.

Available fix commands:
${commandList}

Response format (JSON ONLY, nothing else):
{"commandId": <number or null>, "reason": "<in 1-2 sentences, the root cause you found in the log and why you chose this command>"}`;

  let responseText;
  try {
    responseText = useClaude ? await callClaude(apiKey, prompt) : await callOpenAI(apiKey, prompt);
  } catch (e) {
    const fallbackCmd = pickFallbackCommand(errorMsg, autoFixCommands);
    if (!fallbackCmd) return { ok: false, error: 'AI API error: ' + e.message };
    const runResult = await runCommandFn(server.name, fallbackCmd.command);
    return {
      ok: runResult.ok,
      action: 'ran',
      commandName: fallbackCmd.name,
      output: runResult.output || '',
      reason: `AI API unavailable; fallback command selected by error type (${fallbackCmd.name}).`,
      error: runResult.ok ? undefined : runResult.error,
    };
  }

  let parsed;
  try {
    const jsonMatch = responseText.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) throw new Error('No JSON found');
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    const fallbackCmd = pickFallbackCommand(errorMsg, autoFixCommands);
    if (!fallbackCmd) return { ok: false, error: 'AI returned an invalid response: ' + responseText.slice(0, 150) };
    const runResult = await runCommandFn(server.name, fallbackCmd.command);
    return {
      ok: runResult.ok,
      action: 'ran',
      commandName: fallbackCmd.name,
      output: runResult.output || '',
      reason: `AI returned an invalid response; fallback command selected by error type (${fallbackCmd.name}).`,
      error: runResult.ok ? undefined : runResult.error,
    };
  }

  if (!parsed.commandId) {
    return { ok: true, action: 'none', reason: parsed.reason || 'AI decided no action was needed' };
  }

  const cmd = autoFixCommands.find(c => Number(c.id) === Number(parsed.commandId));
  if (!cmd) {
    return { ok: false, error: 'AI selected an unknown command: id=' + parsed.commandId };
  }

  const runResult = await runCommandFn(server.name, cmd.command);
  let output = runResult.output || '';
  let commandName = cmd.name;
  let reason = parsed.reason || '';

  const selectedName = String(cmd.name || '');
  const looksLikeStatusCheck = /servis durumu|status|kontrol/i.test(selectedName);
  const stillDown = /(inactive|failed|dead|exited|not-found|could not be found|stopped|down)/i.test(output);

  // After status-check: if service still down, run restart
  if (runResult.ok && looksLikeStatusCheck && stillDown) {
    const restartCmd = autoFixCommands.find(c => RESTART_RELAY.test(String(c.name || '')));
    if (restartCmd) {
      const restartResult = await runCommandFn(server.name, restartCmd.command);
      commandName = selectedName + ' -> ' + restartCmd.name;
      output = [output, restartResult.output || restartResult.error || ''].filter(Boolean).join('\n--- restart ---\n');
      reason = (reason ? reason + ' ' : '') + 'Kontrol sonucu servis down gorundu; restart komutu calistirildi.';
      return {
        ok: restartResult.ok,
        action: 'ran',
        commandName,
        output,
        reason,
        error: restartResult.ok ? undefined : restartResult.error,
      };
    }
  }

  // After any fix command: wait 18s then verify service came back; if not, try restart
  const isNotRestartItself = !RESTART_RELAY.test(selectedName);
  if (runResult.ok && isNotRestartItself && !looksLikeStatusCheck) {
    await new Promise(r => setTimeout(r, 18000));
    // Çoklu-instance sunucularda servis adı anon@Nickname / anon1.service olabilir.
    // Sadece anon@default + anon'a bakmak bu kurulumlarda yanlış "inactive" döndürüp
    // gereksiz restart tetikliyordu. REMOTE_SCRIPT ile aynı dinamik tespiti kullan:
    // herhangi bir anon servisi active/activating ise "active" yaz, yoksa son durumu.
    const verifyCmd = 'S=""; for svc in $(systemctl list-units --state=active,activating,failed --no-legend --plain "anon@*" "anon[0-9]*.service" 2>/dev/null | awk \'{print $1}\') anon anon@default anyone anyone-relay tor-anon; do st=$(systemctl is-active "$svc" 2>/dev/null || true); if [ "$st" = "active" ] || [ "$st" = "activating" ]; then echo active; exit 0; fi; [ -n "$st" ] && S="$st"; done; echo "${S:-inactive}"';
    const verifyResult = await runCommandFn(server.name, verifyCmd);
    // ÖNEMLI: SSH bağlantısı başarısız olduysa (ok=false), servisi kapalı sayma — yanlış restart döngüsünü önler
    const serviceStillDown = verifyResult.ok && /(inactive|failed|unknown)/i.test(verifyResult.output || 'inactive');
    if (serviceStillDown) {
      const restartCmd = autoFixCommands.find(c => RESTART_RELAY.test(String(c.name || '')));
      if (restartCmd) {
        const restartResult = await runCommandFn(server.name, restartCmd.command);
        commandName = selectedName + ' -> ' + restartCmd.name;
        output = [output, `[18s sonra kontrol: servis hala down] `, restartResult.output || restartResult.error || ''].filter(Boolean).join('\n');
        reason = (reason ? reason + ' ' : '') + 'Duzeltme sonrasi servis hala down; restart uygulandi.';
        return {
          ok: restartResult.ok,
          action: 'ran',
          commandName,
          output,
          reason,
          error: restartResult.ok ? undefined : restartResult.error,
        };
      }
    }
  }

  return {
    ok: runResult.ok,
    action: 'ran',
    commandName,
    output,
    reason,
    error: runResult.ok ? undefined : runResult.error,
  };
}

// pickFallbackCommand denetim kosumundan test edilebilsin diye disa aciliyor:
// anahtarsiz calisan tek karar noktasi bu, kalipla degil CALISTIRILARAK dogrulanmali.
module.exports = { analyzeAndFix, pickFallbackCommand };

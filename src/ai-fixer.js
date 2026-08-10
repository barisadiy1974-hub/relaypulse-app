// AI-powered auto-fix: analyzes relay failures and runs the appropriate fix command.
// Supports OpenAI (gpt-4o-mini) and Claude (claude-sonnet-4-5) providers.

async function callOpenAI(apiKey, userPrompt) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
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
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
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

function pickFallbackCommand(errorMsg, autoFixCommands) {
  const msg = String(errorMsg || '').toLowerCase();
  if (!msg) return null;

  const findByName = (pattern) => autoFixCommands.find(c => pattern.test(String(c.name || '')));

  if (/dashboard_running=false|running=false|relay agda gorunmuyor|guard.*path|path.*restriction|enforce.*subnet|port.*missing|relay port/.test(msg)) {
    return findByName(/guard path.*duzelt|enforced.*subnet|tam otomatik relay/i) || findByName(/relay zorunlu yenileme/i);
  }
  if (/anon servisi (inactive|failed) oldu|inactive|deactivated|failed to bind|relay offline|anon.*failed|failed.*anon/.test(msg)) {
    return findByName(/relay yeniden baslatma/i);
  }
  if (/ssh master|ssh cevap vermiyor|ssh baglantisi|connection refused|permission denied|host key|banner|handshake|sshd|port 22/.test(msg)) {
    return findByName(/ssh enable ve restart/i) || findByName(/ssh servisi yeniden baslatma/i);
  }
  if (/fail2ban|ban/.test(msg)) {
    return findByName(/fail2ban ban kaldir/i);
  }
  return null;
}

// Main entry point. Returns { ok, action, commandName?, output?, reason, error? }
// action is 'ran' | 'none' | undefined (on error)
async function analyzeAndFix({ server, errorMsg, recentLogs, cfg, runCommandFn }) {
  const { openaiApiKey, claudeApiKey, aiProvider, autoFixCommands = [] } = cfg;
  const useClaude = aiProvider === 'claude' || (!openaiApiKey && claudeApiKey);
  const apiKey = useClaude ? (claudeApiKey || cfg.aiApiKey) : (openaiApiKey || cfg.aiApiKey || claudeApiKey);

  if (!apiKey || !apiKey.trim()) {
    return { ok: false, error: 'API key eksik. Ayarlar > AI Auto-Fix kismina API key girin.' };
  }
  if (!autoFixCommands.length) {
    return { ok: false, error: 'Komut listesi bos. Ayarlar > AI Auto-Fix kismina komut ekleyin.' };
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
    hasCoreDump && 'LOG: SIGABRT/core dump tespit edildi',
    hasBandwidthError && 'LOG: BandwidthRate/BandwidthBurst hatasi var',
    hasBindError && 'LOG: "Address already in use" - port catismasi',
    hasGuardPath && 'LOG: Guard path restriction hatasi',
    hasPermError && 'LOG: Permission denied hatasi',
    hasDiskFull && 'LOG: Disk dolu (no space left)',
    hasConfigError && 'LOG: Konfigurasyon hatasi',
  ].filter(Boolean).join('\n');

  const prompt = `Sen bir Linux sunucu yonetim asistanisin. Anyone Network relay sunucularini izliyorsun.
Sadece JSON ile cevap ver, baska hicbir sey yazma.

Sunucu: ${server.name}
Hata bildirimi: ${String(errorMsg || '').slice(0, 500)}
${logHints ? `\nLog analizi ozeti:\n${logHints}` : ''}

Son 100 log satiri (DIKKATLI OKU — asil nedeni buradan bul):
${logText}

KARAR KURALLARI (oncelik sirasi ile uy):
1. ONCE LOGLARI OKU — hata nedenini logdan tespit et, koru restart yapma.
2. Disk dolu ise: "disk temizleme" komutunu sec.
3. SIGABRT/core dump + BandwidthRate goruyorsan: BandwidthRate satirlarini sil + restart komutu sec.
4. "Address already in use" varsa: sureci durdur + yeniden baslat komutu sec.
5. Guard path restriction varsa: diagnostik/teshis komutunu sec, direkt restart degil.
6. Konfigurasyon hatasi varsa: once log/durum kontrol komutunu sec.
${dashboardIssue ? '7. DASHBOARD SORUNU: Relay agda gorunmuyor — "tam otomatik relay teshis ve duzeltme" komutunu sec.' : ''}
${serviceIsDown && !hasConfigError && !hasDiskFull && !hasGuardPath ? '7. Servis down ve logda spesifik hata yok — restart komutunu sec.' : ''}
- Loglarda net bir neden goruyorsan ona uygun komutu sec, yoksa "tam otomatik relay teshis ve duzeltme" veya "son 50 satir log" sec.
- Sadece gercekten mudahale gerekiyorsa komut sec; emin degilsen log komutunu sec.

Kullanilabilir duzeltme komutlari:
${commandList}

Yanit formati (SADECE JSON, baska hicbir sey yazma):
{"commandId": <sayi veya null>, "reason": "<logdan buldugun asil nedeni ve neden bu komutu sectini 1-2 cumlede yaz>"}`;

  let responseText;
  try {
    responseText = useClaude ? await callClaude(apiKey, prompt) : await callOpenAI(apiKey, prompt);
  } catch (e) {
    const fallbackCmd = pickFallbackCommand(errorMsg, autoFixCommands);
    if (!fallbackCmd) return { ok: false, error: 'AI API hatasi: ' + e.message };
    const runResult = await runCommandFn(server.name, fallbackCmd.command);
    return {
      ok: runResult.ok,
      action: 'ran',
      commandName: fallbackCmd.name,
      output: runResult.output || '',
      reason: `AI API kullanilamadi; hata tipine gore fallback komutu secildi (${fallbackCmd.name}).`,
      error: runResult.ok ? undefined : runResult.error,
    };
  }

  let parsed;
  try {
    const jsonMatch = responseText.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) throw new Error('JSON bulunamadi');
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    const fallbackCmd = pickFallbackCommand(errorMsg, autoFixCommands);
    if (!fallbackCmd) return { ok: false, error: 'AI gecersiz yanit verdi: ' + responseText.slice(0, 150) };
    const runResult = await runCommandFn(server.name, fallbackCmd.command);
    return {
      ok: runResult.ok,
      action: 'ran',
      commandName: fallbackCmd.name,
      output: runResult.output || '',
      reason: `AI gecersiz yanit verdi; hata tipine gore fallback komutu secildi (${fallbackCmd.name}).`,
      error: runResult.ok ? undefined : runResult.error,
    };
  }

  if (!parsed.commandId) {
    return { ok: true, action: 'none', reason: parsed.reason || 'AI mudahale gerekmedi' };
  }

  const cmd = autoFixCommands.find(c => Number(c.id) === Number(parsed.commandId));
  if (!cmd) {
    return { ok: false, error: 'AI bilinmeyen komut secti: id=' + parsed.commandId };
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
    const restartCmd = autoFixCommands.find(c => /relay yeniden baslatma|restart/i.test(String(c.name || '')));
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
  const isNotRestartItself = !/relay yeniden baslatma|restart/i.test(selectedName);
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
      const restartCmd = autoFixCommands.find(c => /relay yeniden baslatma|restart/i.test(String(c.name || '')));
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

module.exports = { analyzeAndFix };

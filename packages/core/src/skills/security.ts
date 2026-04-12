export interface ThreatFinding {
  severity: "high" | "medium" | "low";
  category: string;
  description: string;
  match: string;
}

export interface ThreatReport {
  clean: boolean;
  findings: ThreatFinding[];
}

const TRUSTED_DOMAINS = /github\.com|google\.com|googleapis\.com|api\.trello\.com|atlassian\.net|slack\.com|api\.linear\.app/;

function checkNetworkExfiltration(body: string): ThreatFinding[] {
  const findings: ThreatFinding[] = [];
  const networkTools = [
    { pattern: /\bcurl\b\s+\S*https?:\/\/(\S+)/g, tool: "curl" },
    { pattern: /\bwget\b\s+\S*https?:\/\/(\S+)/g, tool: "wget" },
  ];

  for (const { pattern, tool } of networkTools) {
    let match;
    const re = new RegExp(pattern.source, pattern.flags);
    while ((match = re.exec(body)) !== null) {
      const url = match[0];
      if (!TRUSTED_DOMAINS.test(url)) {
        findings.push({
          severity: "high",
          category: "network_exfiltration",
          description: `Potential network exfiltration via ${tool} to non-trusted domain`,
          match: match[0],
        });
      }
    }
  }

  // Check for nc/ncat/socat regardless of URL
  const rawNetworkTools = [/\bnc\b/, /\bncat\b/, /\bsocat\b/];
  for (const pattern of rawNetworkTools) {
    const match = body.match(pattern);
    if (match) {
      findings.push({
        severity: "high",
        category: "network_exfiltration",
        description: `Potential network exfiltration via ${match[0]}`,
        match: match[0],
      });
    }
  }

  return findings;
}

function checkDestructive(body: string): ThreatFinding[] {
  const findings: ThreatFinding[] = [];
  const patterns: Array<{ re: RegExp; desc: string }> = [
    { re: /rm\s+-rf\s+[\/~]/, desc: "Destructive recursive delete from root or home" },
    { re: /\bmkfs\b/, desc: "Filesystem formatting command" },
    { re: /\bdd\s+if=/, desc: "Low-level disk copy/overwrite" },
    { re: />\s*\/dev\/sd/, desc: "Writing directly to block device" },
  ];

  for (const { re, desc } of patterns) {
    const match = body.match(re);
    if (match) {
      findings.push({
        severity: "high",
        category: "destructive",
        description: desc,
        match: match[0],
      });
    }
  }

  return findings;
}

function checkCredentialAccess(body: string): ThreatFinding[] {
  const findings: ThreatFinding[] = [];
  const patterns: Array<{ re: RegExp; desc: string }> = [
    { re: /\$\w*(KEY|SECRET|TOKEN|PASSWORD)\b/, desc: "Access to sensitive environment variable" },
    { re: /~\/\.ssh/, desc: "Access to SSH keys directory" },
    { re: /~\/\.aws/, desc: "Access to AWS credentials directory" },
    { re: /~\/\.gnupg/, desc: "Access to GPG keys directory" },
    { re: /\/etc\/shadow/, desc: "Access to system password file" },
  ];

  for (const { re, desc } of patterns) {
    const match = body.match(re);
    if (match) {
      findings.push({
        severity: "high",
        category: "credential_access",
        description: desc,
        match: match[0],
      });
    }
  }

  return findings;
}

function checkPrivilegeEscalation(body: string): ThreatFinding[] {
  const findings: ThreatFinding[] = [];
  const patterns: Array<{ re: RegExp; desc: string }> = [
    { re: /\bsudo\b/, desc: "Privilege escalation via sudo" },
    { re: /\bsu\s+-/, desc: "Privilege escalation via su" },
    { re: /\bdoas\b/, desc: "Privilege escalation via doas" },
    { re: /chmod\s+u\+s/, desc: "Setting SUID bit (privilege escalation)" },
  ];

  for (const { re, desc } of patterns) {
    const match = body.match(re);
    if (match) {
      findings.push({
        severity: "high",
        category: "privilege_escalation",
        description: desc,
        match: match[0],
      });
    }
  }

  return findings;
}

function checkEncodedPayloads(body: string): ThreatFinding[] {
  const findings: ThreatFinding[] = [];
  const patterns: Array<{ re: RegExp; desc: string }> = [
    { re: /\bbase64\s+-d/, desc: "Decoding base64 payload" },
    { re: /\beval\b/, desc: "Dynamic code evaluation" },
    { re: /\bexec\b/, desc: "Dynamic code execution" },
  ];

  for (const { re, desc } of patterns) {
    const match = body.match(re);
    if (match) {
      findings.push({
        severity: "medium",
        category: "encoded_payload",
        description: desc,
        match: match[0],
      });
    }
  }

  return findings;
}

function checkScriptExecution(body: string): ThreatFinding[] {
  const findings: ThreatFinding[] = [];
  const patterns: Array<{ re: RegExp; desc: string }> = [
    { re: /python[23]?\s+-c/, desc: "Inline Python script execution" },
    { re: /node\s+-e/, desc: "Inline Node.js script execution" },
    { re: /perl\s+-e/, desc: "Inline Perl script execution" },
  ];

  for (const { re, desc } of patterns) {
    const match = body.match(re);
    if (match) {
      findings.push({
        severity: "medium",
        category: "script_execution",
        description: desc,
        match: match[0],
      });
    }
  }

  return findings;
}

function checkPipeToShell(body: string): ThreatFinding[] {
  const findings: ThreatFinding[] = [];
  const patterns: Array<{ re: RegExp; desc: string }> = [
    { re: /\|\s*bash/, desc: "Piping output to bash shell" },
    { re: /\|\s*sh\b/, desc: "Piping output to sh shell" },
    { re: /\|\s*zsh/, desc: "Piping output to zsh shell" },
  ];

  for (const { re, desc } of patterns) {
    const match = body.match(re);
    if (match) {
      findings.push({
        severity: "medium",
        category: "pipe_to_shell",
        description: desc,
        match: match[0],
      });
    }
  }

  return findings;
}

export function scanSkillForThreats(body: string, isBuiltin: boolean): ThreatReport {
  if (isBuiltin) {
    return { clean: true, findings: [] };
  }

  const findings: ThreatFinding[] = [
    ...checkNetworkExfiltration(body),
    ...checkDestructive(body),
    ...checkCredentialAccess(body),
    ...checkPrivilegeEscalation(body),
    ...checkEncodedPayloads(body),
    ...checkScriptExecution(body),
    ...checkPipeToShell(body),
  ];

  return {
    clean: findings.length === 0,
    findings,
  };
}

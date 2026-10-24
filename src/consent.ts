import type { ConsentDescription } from '@cloudflare/workers-oauth-provider';

const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const styles = `
:root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #293b33; background: #f5f3eb; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; min-height: 100dvh; padding: 48px 24px; display: grid; place-items: center; background: radial-gradient(ellipse at 15% 10%, #e6eddf 0, transparent 46%), radial-gradient(ellipse at 90% 90%, #eae3d1 0, transparent 42%), #f5f3eb; }
.shell { width: 100%; max-width: 520px; }
.brand { display: flex; align-items: center; justify-content: center; gap: 10px; margin-bottom: 28px; color: #254e3d; }
.brand-mark { width: 36px; height: 36px; display: grid; place-items: center; background: #254e3d; border-radius: 11px; color: #fff; }
.brand-name { font: 600 28px Georgia, "Times New Roman", serif; letter-spacing: -.8px; }
.brand-note { text-align: center; font-size: 12px; color: #66746a; letter-spacing: .04em; margin: -16px 0 28px; }
.card { overflow: hidden; padding: 34px; background: #fffefa; border: 1px solid #dedfd5; border-radius: 24px; box-shadow: 0 20px 65px #334b3210, 0 3px 10px #334b3205; }
.connection { display: flex; align-items: center; justify-content: center; gap: 15px; margin-bottom: 26px; }
.app-mark { display: grid; place-items: center; width: 52px; height: 52px; border: 1px solid #dce2d7; border-radius: 16px; background: #eef2e9; font-weight: 600; font-size: 22px; }
.atlas-mark { color: #fff; background: #254e3d; border-color: #254e3d; }
.connection-line { width: 36px; border-top: 1px dashed #b7c4b7; }
.eyebrow { margin: 0 0 12px; font-size: 10px; font-weight: 700; letter-spacing: .16em; color: #6b7e6d; text-align: center; text-transform: uppercase; }
h1 { margin: 0 auto 12px; max-width: 390px; font: 400 30px/1.2 Georgia, "Times New Roman", serif; letter-spacing: -.65px; text-align: center; overflow-wrap: anywhere; }
.intro { margin: 0 auto 27px; max-width: 360px; color: #6a746a; font-size: 14px; line-height: 1.6; text-align: center; }
.details { margin: 0 0 26px; padding: 15px 17px; background: #f5f6f0; border: 1px solid #e7e9de; border-radius: 13px; }
.detail { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; padding: 5px 0; font-size: 12px; }
dl { margin: 0; }
dt { color: #737e72; flex-shrink: 0; }
dd { margin: 0; text-align: right; font-weight: 500; overflow-wrap: anywhere; min-width: 0; }
.publisher { margin: 9px 0 0; padding-top: 10px; border-top: 1px solid #e1e6d9; font-size: 11px; line-height: 1.6; color: #707c6e; overflow-wrap: anywhere; }
h2 { margin: 0 0 14px; font-size: 12px; font-weight: 650; color: #52624f; }
.permissions { list-style: none; margin: 0 0 24px; padding: 0; display: grid; gap: 15px; }
.permission { display: grid; grid-template-columns: 26px 1fr; gap: 10px; align-items: start; }
.check { display: grid; place-items: center; width: 23px; height: 23px; margin-top: 1px; border-radius: 50%; background: #edf3e8; color: #3d684b; font-size: 13px; }
.permission strong { display: block; font-size: 13px; font-weight: 550; line-height: 1.5; }
.permission p { margin: 2px 0 0; font-size: 12px; line-height: 1.5; color: #7a8277; }
.notice { padding: 12px 14px; margin: 0 0 20px; background: #fff7e5; border: 1px solid #ebdec1; border-radius: 10px; color: #806433; font-size: 12px; line-height: 1.6; }
form { display: grid; gap: 9px; }
button { display: flex; align-items: center; justify-content: center; gap: 9px; width: 100%; padding: 14px 12px; border-radius: 11px; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
.allow { color: #fff; background: #254e3d; border: 1px solid #254e3d; box-shadow: 0 3px 6px #254e3d12; }
.allow:hover { background: #1b3d2e; border-color: #1b3d2e; }
.deny { color: #677264; background: transparent; border: 1px solid transparent; }
.deny:hover { background: #f1f3eb; border-color: #e5e8dd; }
button:focus-visible { outline: 3px solid #97b98c; outline-offset: 3px; }
button svg { flex-shrink: 0; }
.owner-note { padding: 17px 28px; margin: 0; text-align: center; font-size: 11px; line-height: 1.7; color: #7f887a; }
.scopes { margin: 0; text-align: center; font-size: 10px; line-height: 1.7; color: #8b9386; overflow-wrap: anywhere; }
@media (max-width: 520px) { body { padding: 28px 16px; } .card { padding: 27px 22px; border-radius: 20px; } h1 { font-size: 27px; } .brand { margin-bottom: 25px; } .detail { gap: 10px; } }
`;

const book = `<svg width="23" height="23" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 6c-3-2-6-2-9-1v14c3-1 6-1 9 1m0-14c3-2 6-2 9-1v14c-3-1-6-1-9 1m0-14v14" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
const github = `<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .75a11.25 11.25 0 0 0-3.558 21.923c.563.104.77-.244.77-.543v-2.094c-3.13.68-3.79-1.328-3.79-1.328-.512-1.302-1.25-1.65-1.25-1.65-1.023-.699.077-.685.077-.685 1.13.08 1.725 1.16 1.725 1.16 1.005 1.723 2.637 1.225 3.28.937.103-.728.393-1.225.715-1.507-2.498-.284-5.124-1.249-5.124-5.56 0-1.229.44-2.233 1.16-3.02-.117-.284-.503-1.428.11-2.976 0 0 .945-.302 3.094 1.154a10.8 10.8 0 0 1 5.626 0c2.15-1.456 3.094-1.154 3.094-1.154.613 1.548.227 2.692.11 2.976.722.787 1.16 1.791 1.16 3.02 0 4.322-2.63 5.273-5.135 5.552.404.35.764 1.043.764 2.102v3.13c0 .302.204.652.775.542A11.25 11.25 0 0 0 12 .75Z"/></svg>`;

export function consentPage(details: ConsentDescription, handle: string, nonce: string): string {
  const name = escape(details.clientName);
  const publisher = details.clientDomain
    ? `Client domain: <strong>${escape(details.clientDomain)}</strong>.`
    : 'This client registered itself; its name is not verified.';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect to Atlas</title><style nonce="${nonce}">${styles}</style></head><body>
<div class="shell">
<header class="brand"><span class="brand-mark">${book}</span><span class="brand-name">Atlas</span></header>
<p class="brand-note">A little space for everything you want to read.</p>
<main class="card" aria-labelledby="consent-title">
<div class="connection" aria-hidden="true"><span class="app-mark">${escape(Array.from(details.clientName)[0]?.toUpperCase() || 'A')}</span><span class="connection-line"></span><span class="app-mark atlas-mark">${book}</span></div>
<p class="eyebrow">Your personal reading list</p>
<h1 id="consent-title">Connect ${name}<br>to Atlas?</h1>
<p class="intro">Give this app access to your reading list.<br>You stay in control of who gets in.</p>
<section class="details" aria-label="Connection details"><dl><div class="detail"><dt>Connecting app</dt><dd>${name}</dd></div>
<div class="detail"><dt>Return to</dt><dd>${escape(details.redirectHost)}</dd></div>
</dl><p class="publisher">${publisher}</p></section>
<h2>This connection will be able to</h2>
<ul class="permissions">
<li class="permission"><span class="check" aria-hidden="true">✓</span><div><strong>Read your saved books</strong><p>View your reading list, notes, and book details.</p></div></li>
<li class="permission"><span class="check" aria-hidden="true">✓</span><div><strong>Manage your reading list</strong><p>Add, edit, and delete books, tags, and reading status.</p></div></li>
${details.scope.includes('offline_access') ? '<li class="permission"><span class="check" aria-hidden="true">✓</span><div><strong>Stay connected</strong><p>Renew access without signing in again, for up to 30 days.</p></div></li>' : ''}
</ul>
${details.redirectIsLoopback ? '<p class="notice">Access will be sent to an app on your computer. Continue only if you just started this connection.</p>' : ''}
<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${escape(handle)}">
<button class="allow" type="submit" name="decision" value="approve">${github} Allow and sign in with GitHub</button>
<button class="deny" type="submit" name="decision" value="deny">Deny</button>
</form></main>
<p class="owner-note">Only the GitHub account that owns this reading list can connect.<br>GitHub is used to verify your identity.</p>
<p class="scopes">Requested scopes: ${details.scope.map(escape).join(', ')}</p>
</div></body></html>`;
}

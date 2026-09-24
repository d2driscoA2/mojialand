// Code emails through Resend. Skipped (and logged) when EMAIL_API_KEY is missing.
import { codeNoDashes } from './codes.mjs';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function fmtDetroit(iso) {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/Detroit', weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
}

// Builds {subject, text, html}. code is null for add/up (codes are not stored).
export function buildEmail({ plan, pass, code, origin }) {
  const forever = pass.kind === 'forever';
  const subject = {
    pass: 'Mojialand: your 48-hour pass code',
    life: 'Mojialand: your Forever code',
    add: 'Mojialand: 48 hours added',
    up: 'Mojialand: you have Forever',
  }[plan];
  const head = {
    pass: 'You\'re all set for 48 hours!',
    life: 'Mojialand is yours for good!',
    add: 'We added 48 hours to your pass.',
    up: 'You have Forever now!',
  }[plan];
  const when = !forever && pass.ends_at ? 'Your pass is on until ' + fmtDetroit(pass.ends_at) + '.' : 'Your Forever pass never ends.';
  const link = code ? origin + '/r/' + codeNoDashes(code) : null;
  const codeLine = code ? 'Your code: ' + code : 'Your code stays the same as before.';
  const keep = 'Keep this email. Your code works on up to 5 devices.';

  const text = [
    head, '', codeLine, '', when,
    link ? 'Open this link on another phone or tablet to turn the pass on there: ' + link : '',
    '', keep, '',
    'Questions? Reply to this email or write to hello@mojialand.com.', '',
    'Mojialand is made by DisplayedUX: https://displayedux.com',
  ].filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');

  const P = '#7138D1', INK = '#30254A', CREAM = '#FFF8E8', DEEP = '#5122A5';
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:${CREAM}">
<div style="max-width:520px;margin:0 auto;padding:28px 20px;font-family:Nunito,'Segoe UI',Helvetica,Arial,sans-serif;color:${INK}">
<div style="font-size:30px;font-weight:900;color:${P};text-align:center;margin-bottom:6px">Mojialand</div>
<div style="background:#fff;border-radius:24px;padding:24px;box-shadow:0 4px 12px rgba(0,0,0,.08)">
<p style="font-size:22px;font-weight:900;margin:0 0 14px;color:${DEEP}">${esc(head)}</p>
${code ? `<p style="margin:0 0 6px;font-size:14px">Your code</p>
<p style="margin:0 0 16px;font:900 26px/1.2 ui-monospace,Menlo,Consolas,monospace;letter-spacing:2px;background:#F3ECFC;color:${DEEP};border-radius:16px;padding:14px;text-align:center">${esc(code)}</p>`
    : `<p style="margin:0 0 16px;font-size:15px">${esc(codeLine)}</p>`}
<p style="margin:0 0 14px;font-size:15px">${esc(when)}</p>
${link ? `<p style="margin:0 0 18px;font-size:15px">On another phone or tablet, open this link and the pass turns on:<br><a href="${esc(link)}" style="color:${P};font-weight:800">${esc(link)}</a></p>` : ''}
<p style="margin:0;font-size:15px;font-weight:800">${esc(keep)}</p>
</div>
<p style="font-size:13px;text-align:center;margin:18px 0 4px">Questions? Write to <a href="mailto:hello@mojialand.com" style="color:${P}">hello@mojialand.com</a></p>
<p style="font-size:13px;text-align:center;margin:0">Mojialand is made by <a href="https://displayedux.com" style="color:${P}">DisplayedUX</a></p>
</div></body></html>`;
  return { subject, text, html };
}

export async function sendEmail(to, msg) {
  if (!process.env.EMAIL_API_KEY) {
    console.log('email skipped');
    return false;
  }
  const res = await globalThis.fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.EMAIL_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM,
      to: [to],
      reply_to: 'hello@mojialand.com',
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
    }),
  });
  if (!res.ok) throw new Error('email send failed ' + res.status);
  return true;
}
